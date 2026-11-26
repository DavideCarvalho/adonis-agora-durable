import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleSideOptions } from '../../src/control-plane-redis/console-auth.js';
import { consoleCommandPublicKey } from '../../src/control-plane-redis/console-auth.js';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { answerConsoleCommands } from '../../src/dashboard/federation.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import type { DashboardEngine } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { ConsoleCommand } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import {
  FakeAuthkit,
  FakeAuthkitWithDirectory,
  FakeCryptoServer,
  FakeKeyDirectory,
} from '../support/fake-crypto-runtime.js';
import { RedisBus, settle } from '../support/redis-bus.js';

/**
 * The console side of the federated console, through the dashboard provider's real boot: each
 * configured app's commands are authenticated with what is explicit, else with the siblings booted
 * in the console app (`@adonis-agora/crypto`, authkit's calls between apps). An entry that may act
 * and resolves nothing fails the boot (web) — never an ace command.
 */

interface ProviderInternals {
  boot(): Promise<void>;
  visibleApps(config: unknown, ctx: unknown): Promise<Array<{ id: string; actions?: string }>>;
  consoleDeps(
    config: unknown,
    topology: string,
  ): (ctx?: unknown) => Promise<{ engine: DashboardEngine }>;
}

const planes: RedisControlPlane[] = [];
afterEach(async () => {
  for (const p of planes.splice(0)) await p.close();
});

function plane(bus: RedisBus, prefix = 'shop', side?: ConsoleSideOptions) {
  const p = new RedisControlPlane({
    connection: bus.connection(),
    prefix,
    pingIntervalMs: 0,
    ...(side ? { console: side } : {}),
  });
  planes.push(p);
  return p;
}

function ctxWith(qs: Record<string, string>) {
  return {
    request: {
      qs: () => qs,
      url: () => '/durable/api/runs',
      method: () => 'GET',
      header: () => undefined,
    },
    auth: { user: { email: 'ops@example.test' } },
  } as never;
}

async function bootConsole(
  dashboard: Record<string, unknown>,
  env: { bindings?: Record<string, unknown>; environment?: string } = {},
) {
  const { default: DashboardProvider } = await import('../../providers/dashboard_provider.js');
  const lines: string[] = [];
  const logger = {
    info: (l: string) => lines.push(`info ${l}`),
    warn: (l: string) => lines.push(`warn ${l}`),
    error: (l: string) => lines.push(`error ${l}`),
  };
  const values = new Map<string, unknown>([
    ['logger', logger],
    ...Object.entries(env.bindings ?? {}),
  ]);
  const app = {
    inProduction: false,
    config: {
      get: (key: string, fallback?: unknown) =>
        key === 'durable_dashboard' ? dashboard : (fallback ?? {}),
    },
    getEnvironment: () => env.environment ?? 'web',
    container: {
      hasBinding: (key: string) => values.has(key),
      hasAllBindings: () => false,
      bindValue: (key: string, value: unknown) => values.set(key, value),
      singleton: (key: string, factory: () => unknown) => values.set(key, factory()),
      bind: (key: string, factory: () => unknown) => values.set(key, factory()),
      make: async (key: unknown) => {
        if (values.has(key as string)) return values.get(key as string);
        throw new Error(`no binding ${String(key)}`);
      },
    },
    booted: async () => undefined,
  };
  const provider = new DashboardProvider(app as never) as unknown as ProviderInternals;
  await provider.boot();
  const { resolveConfig } = await import('../../src/dashboard/define_config.js');
  return { provider, lines, config: resolveConfig(dashboard as never) };
}

/** The app `shop`, answering over `bus` with `auth` (actions on), recording what it ran. */
async function shopApp(bus: RedisBus, auth: Parameters<typeof answerConsoleCommands>[3]) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, instanceId: 'shop' });
  const seen: ConsoleCommand[] = [];
  const owner = plane(bus);
  const answer = owner.onConsoleCommand.bind(owner);
  owner.onConsoleCommand = (handler, opts) =>
    answer(async (command) => {
      seen.push(command);
      return handler(command);
    }, opts);
  answerConsoleCommands(owner, storeDashboardEngine(engine), undefined, {
    actions: true,
    ...auth,
  });
  await settle();
  return { seen, store };
}

describe('federated console, console side: automatic modes through the provider boot', () => {
  it('an entry with no authentication fails the boot (web), suggesting `actions: false`', async () => {
    const bus = new RedisBus();
    await expect(
      bootConsole({
        authorize: () => true,
        apps: { shop: { store: new InMemoryStateStore(), controlPlane: plane(bus) } },
      }),
    ).rejects.toThrow(
      /durable_dashboard\.apps\["shop"\]: commands to this app need authentication: .* — or actions: false to only browse it\. Run `node ace agora:doctor`/,
    );
  });

  it('never fails an ace command', async () => {
    const bus = new RedisBus();
    await expect(
      bootConsole(
        {
          authorize: () => true,
          apps: { shop: { store: new InMemoryStateStore(), controlPlane: plane(bus) } },
        },
        { environment: 'console' },
      ),
    ).resolves.toBeDefined();
  });

  it('`actions: false` is browse-only: boots, and the selector says nobody runs actions', async () => {
    const bus = new RedisBus();
    const { provider, config } = await bootConsole({
      authorize: () => true,
      apps: {
        shop: { store: new InMemoryStateStore(), controlPlane: plane(bus), actions: false },
      },
    });
    expect(await provider.visibleApps(config, ctxWith({}))).toMatchObject([
      { id: 'shop', actions: 'none' },
    ]);
  });

  it('crypto embedded in the console (the Hub): seals for the app’s partition, creates the key, sends the viewer’s capabilities', async () => {
    const bus = new RedisBus();
    const server = new FakeCryptoServer();
    const { provider, config, lines } = await bootConsole(
      {
        authorize: () => ({ allowed: true, capabilities: ['durable:read'] }),
        apps: {
          'entre-textos': {
            store: new InMemoryStateStore(),
            // The console-side options ride on the control plane.
            controlPlane: plane(bus, 'shop', { partition: 'shop' }),
          },
        },
      },
      { bindings: { 'agora.crypto': server.runtime('hub', { embedded: true }) } },
    );
    expect(
      lines.some((l) =>
        l.includes(
          '[@adonis-agora/durable] console commands to "entre-textos": crypto (auto, key console-durable, partition shop)',
        ),
      ),
    ).toBe(true);
    // The key is created at boot, before any command.
    await settle();
    expect(server.hasKey('shop', 'console-durable')).toBe(true);
    expect(lines).toContain(
      'info [@adonis-agora/durable] console commands: created the crypto key "console-durable" in partition shop',
    );
    // The app: decrypts with its own operations (a tenant of the Hub's crypto).
    const { seen } = await shopApp(bus, {
      auth: {
        crypto: {
          cipher: server.runtime('shop', { grants: ['crypto:decrypt:console-*'] })
            .operations as never,
        },
      },
    });
    const deps = provider.consoleDeps(config, 'standalone');
    const { engine } = await deps(ctxWith({ app: 'entre-textos' }));
    expect(Array.isArray(await engine.workerHealth?.())).toBe(true);
    expect(server.hasKey('shop', 'console-durable')).toBe(true);
    expect(seen[0]?.capabilities).toEqual(['durable:read']);
    // The viewer may only read: the app refuses the action, whatever its own `actions`.
    await expect(engine.cancel('run-1')).rejects.toMatchObject({ status: 403 });
  });

  it('crypto in a separate app (the console is a crypto tenant): the server seals with the app’s key (`crypto:seal`)', async () => {
    const bus = new RedisBus();
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const { provider, config } = await bootConsole(
      {
        authorize: () => true,
        apps: { shop: { store: new InMemoryStateStore(), controlPlane: plane(bus) } },
      },
      {
        bindings: {
          'agora.crypto': server.runtime('hub', { grants: ['crypto:seal:console-*'] }),
        },
      },
    );
    const { seen } = await shopApp(bus, {
      auth: {
        crypto: {
          cipher: server.runtime('shop', { grants: ['crypto:decrypt:console-*'] })
            .operations as never,
        },
      },
    });
    const { engine } = await provider.consoleDeps(config, 'standalone')(ctxWith({ app: 'shop' }));
    expect(Array.isArray(await engine.workerHealth?.())).toBe(true);
    // Without `authorize` narrowing, the full console set.
    expect(seen[0]?.capabilities).toEqual([
      'durable:read',
      'durable:runs:write',
      'durable:tasks:write',
      'durable:schedules:write',
    ]);
    expect(server.audit.some((a) => a.op === 'seal' && a.partition === 'shop')).toBe(true);

    // A crypto server too old to seal for another app says what to do.
    server.sealsForOthers = false;
    await expect(engine.workerHealth?.()).rejects.toThrow(
      /upgrade @adonis-agora\/crypto on the crypto server|crypto:seal:console-\*/,
    );
  });

  it('with authkit too: the command is sealed and carries the app-call token for the app', async () => {
    const bus = new RedisBus();
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const hubAuthkit = new FakeAuthkit('hub');
    const { provider, config, lines } = await bootConsole(
      {
        authorize: () => true,
        apps: { shop: { store: new InMemoryStateStore(), controlPlane: plane(bus) } },
      },
      {
        bindings: {
          'agora.crypto': server.runtime('hub', { embedded: true }),
          'authkit.client': hubAuthkit,
        },
      },
    );
    expect(lines.some((l) => l.includes('token (authkit app-call, auto)'))).toBe(true);
    const shopAuthkit = new FakeAuthkit('shop', { hub: ['durable:console:*'] });
    const { seen } = await shopApp(bus, {
      auth: {
        crypto: {
          cipher: server.runtime('shop', { grants: ['crypto:decrypt:console-*'] })
            .operations as never,
          requireToken: false,
        },
        verifyTenant: async ({ token }) => {
          const caller = await shopAuthkit.appCallerVerifier().verifyToken(token ?? '');
          return caller
            ? { partition: caller.app, capabilities: caller.capabilities, appCall: true }
            : null;
        },
      },
    });
    const { engine } = await provider.consoleDeps(config, 'standalone')(ctxWith({ app: 'shop' }));
    expect(Array.isArray(await engine.workerHealth?.())).toBe(true);
    expect(hubAuthkit.issued).toEqual(['appcall:hub->shop']);
    expect(seen[0]?.verified).toMatchObject({ partition: 'hub', appCall: true });
  });

  it('`crypto: false` / `token: false` turn the automatic modes off (and an entry that may act then fails the boot)', async () => {
    const bus = new RedisBus();
    const server = new FakeCryptoServer();
    await expect(
      bootConsole(
        {
          authorize: () => true,
          apps: {
            shop: {
              store: new InMemoryStateStore(),
              controlPlane: plane(bus, 'shop', { crypto: false, token: false }),
            },
          },
        },
        {
          bindings: {
            'agora.crypto': server.runtime('hub', { embedded: true }),
            'authkit.client': new FakeAuthkit('hub'),
          },
        },
      ),
    ).rejects.toThrow(
      /Note: `crypto: false` turned the automatic crypto mode off; `token: false` turned the automatic authkit token off\.$/,
    );
  });

  it('authkit without crypto or publicKey: the error says the token must travel sealed', async () => {
    const bus = new RedisBus();
    await expect(
      bootConsole(
        {
          authorize: () => true,
          apps: { shop: { store: new InMemoryStateStore(), controlPlane: plane(bus) } },
        },
        { bindings: { 'authkit.client': new FakeAuthkit('hub') } },
      ),
    ).rejects.toThrow(
      /need authentication: .*Note: authkit is here, but its token must travel sealed: set durable_dashboard\.apps\["shop"\]\.controlPlane\.publicKey/,
    );
  });

  it('authkit’s key directory: no lookup at boot (the app may boot later); the first command fetches the key', async () => {
    const bus = new RedisBus();
    const directory = new FakeKeyDirectory();
    const { provider, config, lines } = await bootConsole(
      {
        authorize: () => true,
        apps: { shop: { store: new InMemoryStateStore(), controlPlane: plane(bus) } },
      },
      { bindings: { 'authkit.client': new FakeAuthkitWithDirectory('hub', directory) } },
    );
    expect(directory.lookups).toBe(0);
    expect(lines).toContain(
      'info [@adonis-agora/durable] console commands to "shop": token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    );
    // Nothing warns about a key not published yet.
    expect(lines.filter((l) => l.startsWith('warn'))).toEqual([]);
    // The app publishes after the console booted; the first command fetches it.
    directory.keys.set('shop/console:durable', {
      kty: 'OKP',
      crv: 'X25519',
      x: consoleCommandPublicKey('app-key-of-the-shop-0123456789', 'shop'),
    });
    const { engine } = await provider.consoleDeps(config, 'standalone')(ctxWith({ app: 'shop' }));
    // Nobody answers here (no app on this bus): what matters is the lookup, at send time.
    await expect(engine.workerHealth?.()).rejects.toBeDefined();
    expect(directory.lookups).toBe(1);
  });
});

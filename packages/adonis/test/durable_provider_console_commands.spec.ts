import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import { workerStarted } from '../src/console-channel-start.js';
import {
  type ConsoleCommandAuthOptions,
  consoleCommandPublicKey,
} from '../src/control-plane-redis/console-auth.js';
import {
  appCallTokenSource,
  appConsoleCipher,
  consoleSideCipher,
} from '../src/control-plane-redis/console-crypto.js';
import { resolveConsoleSideAuth } from '../src/control-plane-redis/console-resolve.js';
import { RedisControlPlane } from '../src/control-plane-redis/index.js';
import { FederatedApp } from '../src/dashboard/federation.js';
import type { DurableConfig } from '../src/define_config.js';
import {
  InMemoryStateStore,
  type TenantVerifier,
  transports,
  WorkflowEngine,
} from '../src/index.js';
import {
  FakeAuthkit,
  FakeAuthkitWithDirectory,
  FakeCryptoServer,
  FakeKeyDirectory,
} from './support/fake-crypto-runtime.js';
import { RedisBus, settle } from './support/redis-bus.js';

const APP_KEY = 'app-key-of-the-shop-0123456789';

/** A logger whose methods read `this` (as pino's do): calling one detached throws. */
class ThisBoundLogger {
  constructor(private readonly out: string[]) {}
  info(line: string) {
    this.out.push(`info ${line}`);
  }
  warn(line: string) {
    this.out.push(`warn ${line}`);
  }
  error(line: string) {
    this.out.push(`error ${line}`);
  }
}

/** The provider booted on a fake app whose control plane is the in-memory Redis bus. */
async function boot(
  consoleCommands: NonNullable<DurableConfig['consoleCommands']>,
  extra: DurableConfig = {},
  env: { bindings?: Record<string, unknown>; environment?: string } = {},
) {
  const bus = new RedisBus();
  const store = new InMemoryStateStore();
  const controlPlane = new RedisControlPlane({
    connection: bus.connection(),
    prefix: 'shop',
    pingIntervalMs: 0,
  });
  const config: DurableConfig = {
    store: 'mem',
    stores: { mem: async () => store },
    controlPlane,
    workflowsPath: false,
    stepsPath: false,
    consoleCommands,
    ...extra,
  } as DurableConfig;
  const lines: string[] = [];
  // Methods that need `this`, like pino's: a detached call (`(logger.warn ?? …)(x)`) throws.
  const logger = new ThisBoundLogger(lines);
  let factory: (() => unknown) | undefined;
  let engine: unknown;
  const app = {
    config: {
      get: (key: string, fallback?: unknown) =>
        key === 'durable' ? config : key === 'app.appKey' ? APP_KEY : fallback,
    },
    getEnvironment: () => env.environment ?? 'web',
    makePath: (...parts: string[]) => parts.join('/'),
    container: {
      hasBinding: (key: string) => Object.hasOwn(env.bindings ?? {}, key),
      singleton: (_key: unknown, f: () => unknown) => {
        factory = f;
      },
      make: async (key: unknown) => {
        if (key === WorkflowEngine) {
          engine ??= await factory?.();
          return engine;
        }
        if (key === 'logger') return logger;
        if (typeof key === 'string' && env.bindings && Object.hasOwn(env.bindings, key)) {
          return env.bindings[key];
        }
        throw new Error(`no binding ${String(key)}`);
      },
    },
  } as unknown as ApplicationService;
  const provider = new DurableProvider(app);
  provider.register();
  await provider.boot();
  await provider.ready();
  return { bus, store, lines, provider, controlPlane, engine: () => engine };
}

const providers: DurableProvider[] = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown?.();
});

describe('DurableProvider consoleCommands', () => {
  it('fails the boot (web) when no authentication resolves, naming the three ways out', async () => {
    await expect(boot(true)).rejects.toThrow(
      /^\[@adonis-agora\/durable\] consoleCommands needs authentication: install and boot @adonis-agora\/crypto in this app \(automatic, key console-durable\), or configure authkit-client's `service` \(automatic: the console uses an authkit app-call token; grant it durable:console:\* on this app\), or set consoleCommands\.secret \(shared with the console\), or consoleCommands\.verifyTenant \(your own verifier; needs an APP_KEY\)\. Run `node ace agora:doctor` to see every Agora lib's console auth at once\. Docs: /,
    );
  });

  it('an ace command (console environment) never opens the console channel; a worker loop does', async () => {
    const secret = 'console-secret-0123456789';
    const { bus, lines, provider, engine } = await boot({ secret }, {}, { environment: 'console' });
    providers.push(provider);
    await settle();
    // Resolved at boot, but no subscription: a publish on the console channel reaches nobody.
    expect(await bus.connection().publish('shop-console', '{}')).toBe(0);
    expect(lines.some((l) => l.includes('console commands: secret'))).toBe(false);
    // `durable:work`'s loop starting on this engine opens it.
    await workerStarted(engine() as object);
    expect(await bus.connection().publish('shop-console', '{}')).toBe(1);
    expect(lines).toContain(
      'info [@adonis-agora/durable] console commands: secret; actions off (set consoleCommands.actions to let the console act)',
    );
    // Starting twice (the embedded worker after ready) subscribes once.
    await workerStarted(engine() as object);
    expect(await bus.connection().publish('shop-console', '{}')).toBe(1);
  });

  it('an ace command does not subscribe to the control plane either; a worker loop does', async () => {
    const secret = 'console-secret-0123456789';
    const { bus, provider, engine } = await boot({ secret }, {}, { environment: 'console' });
    providers.push(provider);
    await settle();
    // Publishing works (a cancel from `durable:runs:cancel`), but nothing in this process listens.
    expect(await bus.connection().publish('shop-control', '{}')).toBe(0);
    (engine() as WorkflowEngine).startConsumers();
    expect(await bus.connection().publish('shop-control', '{}')).toBe(1);
  });

  it('a web process subscribes to the control plane at boot, as before', async () => {
    const secret = 'console-secret-0123456789';
    const { bus, provider } = await boot({ secret });
    providers.push(provider);
    expect(await bus.connection().publish('shop-control', '{}')).toBe(1);
  });

  it('outside web (an ace command) only says it, and answers nothing', async () => {
    const { bus, lines, provider } = await boot(true, {}, { environment: 'console' });
    providers.push(provider);
    expect(lines.some((l) => l.startsWith('error') && /needs authentication/.test(l))).toBe(true);
    // Nobody subscribed to the console channel.
    expect(await bus.connection().publish('shop-console', '{}')).toBe(0);
  });

  it('answers with a shared secret', async () => {
    const secret = 'console-secret-0123456789';
    const { bus, provider } = await boot({ secret });
    providers.push(provider);
    const console = new FederatedApp({
      id: 'shop',
      store: new InMemoryStateStore(),
      controlPlane: new RedisControlPlane({
        connection: bus.connection(),
        prefix: 'shop',
        pingIntervalMs: 0,
      }),
      auth: { secret },
    });
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
  });

  it('token mode: never prints the public key, and checks the token is for this app', async () => {
    const verifyTenant: TenantVerifier = ({ token }) =>
      token === 'hub' ? { partition: 'shop', capabilities: ['durable:read'] } : null;
    const { bus, lines, provider } = await boot({ verifyTenant, partition: 'shop' });
    providers.push(provider);
    const publicKey = consoleCommandPublicKey(APP_KEY, 'shop');
    // The key is never printed: only the mode says token mode is on.
    expect(lines.some((l) => l.includes(publicKey))).toBe(false);
    expect(lines.some((l) => /token \(verifyTenant; sealed to key [0-9a-f]{8}\)/.test(l))).toBe(
      true,
    );
    // The private half never shows.
    expect(lines.join('\n')).not.toContain(APP_KEY);
    const console = new FederatedApp({
      id: 'shop',
      store: new InMemoryStateStore(),
      controlPlane: new RedisControlPlane({
        connection: bus.connection(),
        prefix: 'shop',
        pingIntervalMs: 0,
      }),
      auth: { token: 'hub', publicKey },
    });
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    await expect(console.engine().cancel('run-1')).rejects.toMatchObject({ status: 403 });
  });

  it('a control plane answers for its apps without an allow-list to fill (`apps` only confines)', async () => {
    const secret = 'console-secret-0123456789';
    const { bus, lines, provider } = await boot({ secret }, {
      topology: 'control-plane',
      transport: 'mem',
      transports: { mem: transports.memory() },
      store: 'mem',
    } as DurableConfig);
    providers.push(provider);
    await settle();
    expect(lines.some((l) => l.startsWith('warn'))).toBe(false);
    expect(Array.isArray(await consoleFor(bus, { secret }).engine().workerHealth())).toBe(true);
  });
});

/** The console's side of `shop`, over the same bus, authenticated with `auth`. */
function consoleFor(bus: RedisBus, auth: ConsoleCommandAuthOptions, timeoutMs?: number) {
  return new FederatedApp({
    id: 'shop',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    store: new InMemoryStateStore(),
    controlPlane: new RedisControlPlane({
      connection: bus.connection(),
      prefix: 'shop',
      pingIntervalMs: 0,
    }),
    auth,
  });
}

describe('DurableProvider consoleCommands — a bad message never crashes the app', () => {
  it('garbage and a command it cannot decrypt are logged once per reason and dropped; the app keeps serving', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const crashes: unknown[] = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on('unhandledRejection', onCrash);
    process.on('uncaughtException', onCrash);
    try {
      const { bus, lines, provider } = await boot(
        { actions: true },
        {},
        {
          bindings: {
            // A crypto tenant the server refuses (wrong partition, old server): nothing opens.
            'agora.crypto': server.runtime('shop', { refuse: true }),
          },
        },
      );
      providers.push(provider);
      await settle();
      const publish = (message: string) => bus.connection().publish('shop-console', message);
      for (const junk of ['not json', '{}', '[]', 'null', '{"id":1}', '{"id":"x","mac":"y"}']) {
        await publish(junk);
      }
      // Twice the same undecryptable command (the Hub's first command, before the grant exists).
      const sealed = `agora:ct1:console-durable:1:${'A'.repeat(60)}`;
      await publish(JSON.stringify({ id: 'c1', sealed }));
      await publish(JSON.stringify({ id: 'c2', sealed }));
      await settle();
      expect(crashes).toEqual([]);
      const refused = lines.filter((l) =>
        l.startsWith('warn [@adonis-agora/durable] console commands: refused a command ('),
      );
      // The uniform reasons (§11b), never "(unsigned?)".
      expect(refused.join('\n')).not.toMatch(/unsigned\?/);
      expect(refused).toEqual(
        expect.arrayContaining([
          'warn [@adonis-agora/durable] console commands: refused a command (not JSON)',
          'warn [@adonis-agora/durable] console commands: refused a command (no command id)',
          "warn [@adonis-agora/durable] console commands: refused a command (did not open with this app's key)",
        ]),
      );
      // Once per reason, however many messages.
      expect(new Set(refused).size).toBe(refused.length);
      expect(refused.length).toBeGreaterThan(0);
      // The boot check's refused line says what to check (no grant to add: §2e.A).
      expect(
        lines.some((l) => l.startsWith('warn') && /refused this app.*no grant is needed/.test(l)),
      ).toBe(true);
      // Still serving: the channel is still subscribed.
      expect(await publish('still alive?')).toBe(1);
    } finally {
      process.off('unhandledRejection', onCrash);
      process.off('uncaughtException', onCrash);
    }
  });

  it('refusal reasons are the uniform ones: bad signature, stale, mode not accepted, token refused, capabilities-required', async () => {
    const secret = 'console-secret-0123456789';
    const verifyTenant: TenantVerifier = ({ token }) =>
      token === 'hub' ? { partition: 'shop', capabilities: ['durable:read'] } : null;
    const { bus, lines, provider } = await boot({ secret, verifyTenant, partition: 'shop' });
    providers.push(provider);
    const publish = (message: unknown) =>
      bus.connection().publish('shop-console', JSON.stringify(message));
    // A secret-mode command with a wrong MAC, then one signed with the right secret but stale.
    await publish({ id: 'b1', verb: 'workerHealth', args: [], ts: Date.now(), mac: 'nope' });
    const plane = new RedisControlPlane({
      connection: bus.connection(),
      prefix: 'shop',
      pingIntervalMs: 0,
    });
    const { ConsoleCommandAuth } = await import('../src/control-plane-redis/console-auth.js');
    const signer = new ConsoleCommandAuth({ secret, prefix: 'shop' });
    const realNow = Date.now;
    Date.now = () => realNow() - 5 * 60_000;
    const stale = await signer.wrap({ id: 's1', verb: 'workerHealth', args: [], capabilities: [] });
    Date.now = realNow;
    await publish(stale.wire);
    // A crypto-sealed command: this app does not take crypto.
    await publish({ id: 'm1', sealed: `agora:ct1:console-durable:1:${'A'.repeat(40)}` });
    // A refused token, and a command without capabilities.
    await expect(
      consoleFor(bus, { token: 'intruder', publicKey: consoleCommandPublicKey(APP_KEY, 'shop') })
        .engine()
        .workerHealth(),
    ).rejects.toMatchObject({ status: 401 });
    await plane.sendConsoleCommand(
      { id: 'nc', verb: 'workerHealth', args: [] },
      { auth: { secret } },
    );
    await settle();
    await plane.close();
    const reasons = lines
      .filter((l) => l.includes('console commands: refused a command ('))
      .map((l) =>
        l
          .replace(/^warn \[@adonis-agora\/durable\] console commands: refused a command \(/, '')
          .slice(0, -1),
      );
    expect(reasons).toEqual(
      expect.arrayContaining([
        'bad signature',
        'stale',
        expect.stringMatching(
          /^mode not accepted here \(this app accepts: token \(sealed to key [0-9a-f]{8}\), secret; the command came as crypto \(key console-durable\)\)$/,
        ),
        'token refused',
        'capabilities-required',
      ]),
    );
  });

  it('replayed: logged by the instance that already ran the command; another instance’s claim is silent', async () => {
    const secret = 'console-secret-0123456789';
    const { bus, lines, provider } = await boot({ secret });
    providers.push(provider);
    const { ConsoleCommandAuth } = await import('../src/control-plane-redis/console-auth.js');
    const signer = new ConsoleCommandAuth({ secret, prefix: 'shop' });
    const ran = await signer.wrap({
      id: 'r1',
      verb: 'workerHealth',
      args: [],
      capabilities: ['durable:read'],
    });
    await bus.connection().publish('shop-console', JSON.stringify(ran.wire));
    await settle();
    // The same command again (a replay): this instance ran r1, so it says so.
    await bus.connection().publish('shop-console', JSON.stringify(ran.wire));
    await settle();
    const replayed = 'warn [@adonis-agora/durable] console commands: refused a command (replayed)';
    expect(lines.filter((l) => l === replayed)).toHaveLength(1);

    // A command another instance claimed first: this instance never ran it, so it stays silent.
    const other = await signer.wrap({
      id: 'r2',
      verb: 'workerHealth',
      args: [],
      capabilities: ['durable:read'],
    });
    await bus.connection().set?.('shop-console-claim:r2', 'another-instance', 'PX', 120_000, 'NX');
    const before = lines.length;
    await bus.connection().publish('shop-console', JSON.stringify(other.wire));
    await settle();
    expect(lines.slice(before).filter((l) => l.includes('refused a command'))).toEqual([]);
  });

  it('keeps answering valid commands after garbage', async () => {
    const secret = 'console-secret-0123456789';
    const { bus, provider } = await boot({ secret });
    providers.push(provider);
    for (const junk of ['x', '{"id":"1","mac":"bad","verb":"cancel","ts":1}', '{"sealed":5}']) {
      await bus.connection().publish('shop-console', junk);
    }
    await settle();
    expect(Array.isArray(await consoleFor(bus, { secret }).engine().workerHealth())).toBe(true);
  });
});

describe('DurableProvider consoleCommands — automatic crypto (@adonis-agora/crypto booted here)', () => {
  it('needs no config: seals with console-durable, creates the key, logs the mode, refuses actions until `actions: true`', async () => {
    const server = new FakeCryptoServer();
    const { bus, lines, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    expect(
      lines.some((l) =>
        l.includes('[@adonis-agora/durable] console commands: crypto (auto, key console-durable)'),
      ),
    ).toBe(true);
    // The key is created at boot, before any command.
    await settle();
    expect(server.hasKey('shop', 'console-durable')).toBe(true);
    // The Hub: crypto embedded there too (same server), sealing for the app's partition.
    const hub = server.runtime('hub', { embedded: true });
    const console = consoleFor(bus, { crypto: { cipher: consoleSideCipher(hub, 'shop') } });
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(server.hasKey('shop', 'console-durable')).toBe(true);
    await expect(console.engine().cancel('run-1')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/consoleCommands.actions: true/),
    });
    // The console encrypted (as a principal of the app's partition), the app decrypted.
    expect(
      server.audit.filter((a) => a.op === 'encrypt').every((a) => a.partition === 'shop'),
    ).toBe(true);
    expect(server.audit.some((a) => a.op === 'decrypt' && a.partition === 'shop')).toBe(true);
  });

  it('with `actions: true` the console acts', async () => {
    const server = new FakeCryptoServer();
    const { bus, store, provider } = await boot(
      { actions: true },
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    const console = consoleFor(bus, {
      crypto: { cipher: consoleSideCipher(server.runtime('hub', { embedded: true }), 'shop') },
    });
    await store.createRun({
      id: 'run-1',
      workflow: 'w',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await console.engine().cancel('run-1');
    expect((await store.getRun('run-1'))?.status).toBe('cancelled');
  });

  it('as a tenant of a crypto server: creates the key when its token may, else one INFO line (the server provisions it)', async () => {
    const server = new FakeCryptoServer();
    const allowed = await boot(
      true,
      {},
      {
        bindings: {
          'agora.crypto': server.runtime('shop', { grants: ['crypto:keys:manage:console-*'] }),
        },
      },
    );
    providers.push(allowed.provider);
    await settle();
    expect(server.hasKey('shop', 'console-durable')).toBe(true);

    const other = new FakeCryptoServer();
    const refused = await boot(
      true,
      {},
      {
        bindings: {
          'agora.crypto': other.runtime('shop'),
        },
      },
    );
    providers.push(refused.provider);
    await settle();
    const keyLines = refused.lines.filter((l) => l.includes('console-durable" does not exist'));
    expect(keyLines).toHaveLength(1);
    expect(keyLines[0]).toMatch(/^info .*creates it on the console's first command/);
  });

  it('a key that cannot be created never fails the boot: one actionable line', async () => {
    const server = new FakeCryptoServer();
    const runtime = server.runtime('shop', { embedded: true });
    const service = runtime.service!;
    const broken = {
      ...runtime,
      service: {
        ...service,
        createKey: async () => {
          throw new Error('crypto store unavailable');
        },
      },
    };
    const { lines, provider } = await boot(true, {}, { bindings: { 'agora.crypto': broken } });
    providers.push(provider);
    await settle();
    expect(
      lines.some(
        (l) =>
          l.startsWith('warn') &&
          l.includes('crypto store unavailable') &&
          l.includes(
            'node ace crypto:keys:create console-durable --type aes256-gcm --application shop',
          ),
      ),
    ).toBe(true);
  });

  it('keeps the APP_KEY-sealed token mode alongside crypto when a verifier exists (migration path)', async () => {
    const server = new FakeCryptoServer();
    const verifyTenant: TenantVerifier = ({ token }) =>
      token === 'hub' ? { partition: 'shop', capabilities: ['durable:read'] } : null;
    const { bus, lines, provider } = await boot(
      { verifyTenant, partition: 'shop' },
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    // An explicit verifyTenant is used as given: no automatic crypto, the APP_KEY mode answers.
    expect(lines.some((l) => /token \(verifyTenant; sealed to key [0-9a-f]{8}\)/.test(l))).toBe(
      true,
    );
    const console = consoleFor(bus, {
      token: 'hub',
      publicKey: consoleCommandPublicKey(APP_KEY, 'shop'),
    });
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
  });

  it('with automatic crypto and a fallback verifier, both crypto and the APP_KEY token mode answer', async () => {
    const server = new FakeCryptoServer();
    const verifyTenant: TenantVerifier = ({ token }) =>
      token === 'hub' ? { partition: 'shop', capabilities: ['durable:read'] } : null;
    const { lines, provider } = await boot(
      true,
      {
        topology: 'control-plane',
        transport: 'mem',
        transports: { mem: transports.memory() },
        store: 'mem',
        verifyTenant,
      } as DurableConfig,
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    expect(
      lines.some(
        (l) =>
          l.includes('crypto (auto, key console-durable)') &&
          /token \(control plane verifyTenant; sealed to key [0-9a-f]{8}\)/.test(l),
      ),
    ).toBe(true);
  });

  it('a crypto tenant the server refuses: one warn line, never getKey, never a failed boot', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const { lines, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { refuse: true }) } },
    );
    providers.push(provider);
    await settle();
    const warns = lines.filter((l) => l.startsWith('warn') && l.includes('console-durable'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/refused this app.*no grant is needed/);
  });

  it('a crypto tenant whose key is there: no line at all, and no grant needed (§2e.A)', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const { lines, provider } = await boot(
      true,
      {},
      {
        bindings: { 'agora.crypto': server.runtime('shop') },
      },
    );
    providers.push(provider);
    await settle();
    expect(lines.filter((l) => l.includes('crypto key'))).toEqual([]);
  });

  it('after a boot warning, the next command’s own decrypt is the retry: one line per change, none once healthy', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const down = { value: true };
    const { bus, lines, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { down }) } },
    );
    providers.push(provider);
    await settle();
    const unreachable = () =>
      lines.filter((l) => l.startsWith('warn') && /could not check/.test(l));
    expect(unreachable()).toHaveLength(1);
    // The crypto server is back; the next command decrypts fine and clears the warning.
    down.value = false;
    const console = consoleFor(bus, {
      crypto: { cipher: consoleSideCipher(server.runtime('hub', { embedded: true }), 'shop') },
    });
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(unreachable()).toHaveLength(1);
    // Only one decrypt of the key for that command: no extra check call.
    expect(server.audit.filter((a) => a.op === 'decrypt' && a.partition === 'shop')).toHaveLength(
      1,
    );
  });

  it('the boot error notes a verifier that cannot work without an APP_KEY', async () => {
    const verifyTenant: TenantVerifier = () => null;
    const { resolveAppConsoleAuth } = await import('../src/control-plane-redis/console-resolve.js');
    const resolved = resolveAppConsoleAuth({ verifyTenant, crypto: false });
    expect(resolved.error).toMatch(
      /Note: a token verifier is available \(verifyTenant\), but token mode needs an APP_KEY \(commands are sealed to a key derived from it\); `crypto: false` turned the automatic crypto mode off\.$/,
    );
  });

  it('the boot error names what explains it: `crypto: false`, a verifier without an APP_KEY', async () => {
    const server = new FakeCryptoServer();
    await expect(
      boot(
        { crypto: false },
        {},
        { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
      ),
    ).rejects.toThrow(/Docs: \S+ Note: `crypto: false` turned the automatic crypto mode off\.$/);
  });

  it('`crypto: false` turns the automatic mode off (and nothing else resolves: boot error)', async () => {
    const server = new FakeCryptoServer();
    await expect(
      boot(
        { crypto: false },
        {},
        { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
      ),
    ).rejects.toThrow(/needs authentication/);
  });

  it('an explicit `secret` is used as given: no automatic crypto on top', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const secret = 'console-secret-0123456789';
    const { bus, lines, provider } = await boot(
      { secret },
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    expect(lines).toContain(
      'info [@adonis-agora/durable] console commands: secret; actions off (set consoleCommands.actions to let the console act)',
    );
    const sealed = consoleFor(
      bus,
      { crypto: { cipher: consoleSideCipher(server.runtime('hub', { embedded: true }), 'shop') } },
      300,
    );
    // Not a mode this app accepts: refused unanswered.
    await expect(sealed.engine().workerHealth()).rejects.toThrow(/no instance .* answered/);
  });
});

describe('DurableProvider consoleCommands — automatic token (authkit calls between apps)', () => {
  it('verifies the app-call token inside crypto: its capabilities cap the command, no partition rule', async () => {
    const server = new FakeCryptoServer();
    const authkit = new FakeAuthkit('shop', { hub: ['durable:read'] });
    const { bus, lines, provider } = await boot(
      { actions: true },
      {},
      {
        bindings: {
          'agora.crypto': server.runtime('shop', { embedded: true }),
          'authkit.client': authkit,
        },
      },
    );
    providers.push(provider);
    expect(
      lines.some((l) =>
        l.includes(
          'crypto (auto, key console-durable) + token checked when sent (authkit app-call, auto)',
        ),
      ),
    ).toBe(true);
    const hubAuthkit = new FakeAuthkit('hub');
    const console = consoleFor(bus, {
      crypto: { cipher: consoleSideCipher(server.runtime('hub', { embedded: true }), 'shop') },
      token: appCallTokenSource(hubAuthkit, 'shop')!,
    });
    // `durable:read` granted to the hub on this app: reads pass, actions do not (even with actions on).
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    await expect(console.engine().cancel('run-1')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/the console's token lacks durable:runs:write/),
    });
    // A token for another app (wrong audience) is refused.
    const wrong = consoleFor(bus, {
      crypto: { cipher: consoleSideCipher(server.runtime('hub', { embedded: true }), 'shop') },
      token: async () => 'appcall:hub->elsewhere',
    });
    await expect(wrong.engine().workerHealth()).rejects.toMatchObject({ status: 401 });
  });

  it('`verifyTenant: false` turns the automatic token off', async () => {
    const server = new FakeCryptoServer();
    const authkit = new FakeAuthkit('shop', { hub: [] });
    const { lines, provider } = await boot(
      { verifyTenant: false },
      {},
      {
        bindings: {
          'agora.crypto': server.runtime('shop', { embedded: true }),
          'authkit.client': authkit,
        },
      },
    );
    providers.push(provider);
    expect(lines.some((l) => l.includes('authkit app-call'))).toBe(false);
  });
});

describe('DurableProvider consoleCommands — the control plane’s own verifyTenant (fallback)', () => {
  it('verifies console tokens with it when consoleCommands.verifyTenant is not set', async () => {
    const verifyTenant: TenantVerifier = ({ token }) =>
      token === 'hub' ? { partition: 'acme', capabilities: ['durable:read'] } : null;
    const { bus, lines, provider } = await boot({ apps: ['acme'] }, {
      topology: 'control-plane',
      transport: 'mem',
      transports: { mem: transports.memory() },
      store: 'mem',
      verifyTenant,
    } as DurableConfig);
    providers.push(provider);
    expect(
      lines.some((l) => /token \(control plane verifyTenant; sealed to key [0-9a-f]{8}\)/.test(l)),
    ).toBe(true);
    const console = consoleFor(bus, {
      token: 'hub',
      publicKey: consoleCommandPublicKey(APP_KEY, 'shop'),
    });
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    // A tenant token without a console capability does nothing.
    const tenant = consoleFor(bus, {
      token: 'hub',
      publicKey: consoleCommandPublicKey(APP_KEY, 'shop'),
    });
    await expect(tenant.engine().cancel('r')).rejects.toMatchObject({ status: 403 });
  });
});

describe('token mode with authkit’s key directory (§2e.B): no publicKey line', () => {
  const verifyTenant: TenantVerifier = ({ token }) =>
    token === 'hub' ? { partition: 'shop', capabilities: ['durable:read'] } : null;

  it('the app publishes its public key (never the private half); the console seals to it', async () => {
    const directory = new FakeKeyDirectory();
    const { bus, provider } = await boot(
      { verifyTenant, partition: 'shop' },
      {},
      { bindings: { 'authkit.client': new FakeAuthkitWithDirectory('shop', directory) } },
    );
    providers.push(provider);
    await settle();
    const published = directory.keys.get('shop/console:durable');
    expect(published).toEqual({
      kty: 'OKP',
      crv: 'X25519',
      x: consoleCommandPublicKey(APP_KEY, 'shop'),
    });
    expect(published).not.toHaveProperty('d');
    // The console: a token, no publicKey, authkit's directory booted there.
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      { token: 'hub' },
      { authkit: new FakeAuthkitWithDirectory('hub', directory) },
    );
    expect(resolved.error).toBeUndefined();
    expect(resolved.modes).toEqual([
      expect.stringMatching(
        /^token \(explicit, authkit key directory; sealed to the key the app publishes\)$/,
      ),
    ]);
    const console = consoleFor(bus, resolved.auth!);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
  });

  it('an explicit publicKey wins over the directory', async () => {
    const directory = new FakeKeyDirectory();
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      { token: 'hub', publicKey: consoleCommandPublicKey(APP_KEY, 'shop') },
      { authkit: new FakeAuthkitWithDirectory('hub', directory) },
    );
    expect(resolved.auth?.publicKey).toBe(consoleCommandPublicKey(APP_KEY, 'shop'));
    expect(resolved.modes[0]).toMatch(
      /^token \(explicit, controlPlane\.publicKey; sealed to key [0-9a-f]{8}\)$/,
    );
    expect(directory.lookups).toBe(0);
  });

  it('no key in the directory: the command fails with the actionable message', async () => {
    const { bus, provider } = await boot({ verifyTenant, partition: 'shop' });
    providers.push(provider);
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      { token: 'hub' },
      { authkit: new FakeAuthkitWithDirectory('hub', new FakeKeyDirectory()) },
    );
    await expect(consoleFor(bus, resolved.auth!).engine().workerHealth()).rejects.toThrow(
      /publishes it to authkit's key directory automatically when it has authkit's `service` configured.*controlPlane\.publicKey/,
    );
  });

  it('a plain ace command does not publish (the channel does not start there)', async () => {
    const directory = new FakeKeyDirectory();
    const { provider } = await boot(
      { verifyTenant, partition: 'shop' },
      {},
      {
        environment: 'console',
        bindings: { 'authkit.client': new FakeAuthkitWithDirectory('shop', directory) },
      },
    );
    providers.push(provider);
    await settle();
    expect(directory.keys.size).toBe(0);
  });
});

describe('§13 mixed Hubs: per-app mode, optional token in crypto mode, quiet crypto apps, hasKey', () => {
  /** The Hub's console side for `shop`: embedded crypto and authkit with its key directory. */
  function hubFor(server: FakeCryptoServer, directory: FakeKeyDirectory, warns: string[] = []) {
    return resolveConsoleSideAuth(
      'shop',
      'shop',
      {},
      {
        crypto: server.runtime('hub', { embedded: true }),
        authkit: new FakeAuthkitWithDirectory('hub', directory),
        log: (line, level) => warns.push(`${level} ${line}`),
      },
    );
  }
  const encryptsByConsole = (server: FakeCryptoServer) =>
    server.audit.filter((a) => a.op === 'encrypt' && a.actor === 'durable:console').length;

  it('13a: the boot label says it decides later; an app that publishes a key gets token mode', async () => {
    const server = new FakeCryptoServer();
    const directory = new FakeKeyDirectory();
    // EduLiberta-like: authkit only (publishes its key), no crypto.
    const { bus, provider } = await boot(
      { actions: true },
      {},
      {
        bindings: {
          'authkit.client': new FakeAuthkitWithDirectory('shop', directory, {
            hub: ['durable:console:*'],
          }),
        },
      },
    );
    providers.push(provider);
    await settle();
    const resolved = hubFor(server, directory);
    expect(resolved.modes).toEqual([
      'auto (authkit key directory if the app publishes one, else crypto (auto, key console-durable, partition shop))',
    ]);
    expect(directory.lookups).toBe(0); // nothing at boot
    const console = consoleFor(bus, resolved.auth!);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    // Token mode: crypto never sealed anything, and the choice was made once (cached).
    expect(encryptsByConsole(server)).toBe(0);
    expect(directory.lookups).toBe(1);
  });

  it('13a: an app that publishes no key gets crypto mode', async () => {
    const server = new FakeCryptoServer();
    const directory = new FakeKeyDirectory();
    // ET-like: a crypto tenant; nothing in the directory.
    const { bus, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    const console = consoleFor(bus, hubFor(server, directory).auth!);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(encryptsByConsole(server)).toBe(1);
  });

  it('13a: an unanswered command makes the console decide again', async () => {
    const server = new FakeCryptoServer();
    const directory = new FakeKeyDirectory();
    const bus = new RedisBus();
    // Someone listens on the channel but never answers (an app refusing the mode).
    await bus.connection().subscribe('shop-console', () => undefined);
    const resolved = hubFor(server, directory);
    const console = consoleFor(bus, resolved.auth!, 100);
    await expect(console.engine().workerHealth()).rejects.toThrow(/answered within/);
    await expect(console.engine().workerHealth()).rejects.toThrow(/answered within/);
    expect(directory.lookups).toBe(2);
  });

  it('13b: in crypto mode a failing app-call token never blocks the command (one warn, retried after 5 min)', async () => {
    const server = new FakeCryptoServer();
    const { bus, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    const hubAuthkit = new FakeAuthkit('hub');
    hubAuthkit.failTokens = '503 invalid_target';
    const warns: string[] = [];
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      {},
      {
        crypto: server.runtime('hub', { embedded: true }),
        authkit: hubAuthkit,
        log: (line, level) => warns.push(`${level} ${line}`),
      },
    );
    const console = consoleFor(bus, resolved.auth!);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(warns).toEqual([
      'info [@adonis-agora/durable] console commands to "shop": sending without an authkit app-call token (crypto only): 503 invalid_target. To attach it: grant the console\'s service client durable:console:* on "shop" in authkit.',
    ]);
    expect(hubAuthkit.mintAttempts).toBe(1);
  });

  it('13a: auto-chose token (a stale key in the directory) but the token cannot be minted → crypto, with the §13b warning', async () => {
    const server = new FakeCryptoServer();
    const directory = new FakeKeyDirectory();
    // An older version of the app published a key; the app now runs crypto.
    directory.keys.set('shop/console:durable', {
      kty: 'OKP',
      crv: 'X25519',
      x: consoleCommandPublicKey(APP_KEY, 'shop'),
    });
    const { bus, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    const hubAuthkit = new FakeAuthkitWithDirectory('hub', directory);
    hubAuthkit.failTokens = '403 no grant';
    const warns: string[] = [];
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      {},
      {
        crypto: server.runtime('hub', { embedded: true }),
        authkit: hubAuthkit,
        log: (line, level) => warns.push(`${level} ${line}`),
      },
    );
    const console = consoleFor(bus, resolved.auth!);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(encryptsByConsole(server)).toBe(1);
    // One failing mint for that command (the crypto send does not try again), and inside the
    // 5-minute window the next commands go by crypto with no mint and no directory lookup.
    expect(hubAuthkit.mintAttempts).toBe(1);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(encryptsByConsole(server)).toBe(3);
    expect(hubAuthkit.mintAttempts).toBe(1);
    expect(directory.lookups).toBe(1);
    expect(warns).toEqual([
      'info [@adonis-agora/durable] console commands to "shop": sending without an authkit app-call token (crypto only): 403 no grant. To attach it: grant the console\'s service client durable:console:* on "shop" in authkit.',
    ]);
  });

  it('13a: token mode whose token stops minting mid-window → that command goes by crypto (one mint per command)', async () => {
    const server = new FakeCryptoServer();
    const directory = new FakeKeyDirectory();
    // The app answers both ways: crypto here, and it published its token key.
    const { bus, provider } = await boot(
      { actions: true },
      {},
      {
        bindings: {
          'agora.crypto': server.runtime('shop', { embedded: true }),
          'authkit.client': new FakeAuthkitWithDirectory('shop', directory, {
            hub: ['durable:console:*'],
          }),
        },
      },
    );
    providers.push(provider);
    directory.keys.set('shop/console:durable', {
      kty: 'OKP',
      crv: 'X25519',
      x: consoleCommandPublicKey(APP_KEY, 'shop'),
    });
    const hubAuthkit = new FakeAuthkitWithDirectory('hub', directory);
    const warns: string[] = [];
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      {},
      {
        crypto: server.runtime('hub', { embedded: true }),
        authkit: hubAuthkit,
        log: (line, level) => warns.push(`${level} ${line}`),
      },
    );
    const console = consoleFor(bus, resolved.auth!);
    await console.engine().workerHealth();
    // Token mode: one mint for that command, nothing sealed by crypto.
    expect(hubAuthkit.mintAttempts).toBe(1);
    expect(encryptsByConsole(server)).toBe(0);
    hubAuthkit.failTokens = '503 authkit down';
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(hubAuthkit.mintAttempts).toBe(2);
    expect(encryptsByConsole(server)).toBe(1);
    expect(Array.isArray(await console.engine().workerHealth())).toBe(true);
    expect(hubAuthkit.mintAttempts).toBe(2);
    expect(warns).toEqual([
      'warn [@adonis-agora/durable] console commands to "shop": sending without an authkit app-call token (crypto only): 503 authkit down. To attach it: grant the console\'s service client durable:console:* on "shop" in authkit.',
    ]);
  });

  it('13b: any other minting failure (authkit down) is a warning, same wording', async () => {
    const server = new FakeCryptoServer();
    const { bus, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    const hubAuthkit = new FakeAuthkit('hub');
    hubAuthkit.failTokens = 'connect ECONNREFUSED 127.0.0.1:3333';
    const notes: string[] = [];
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      {},
      {
        crypto: server.runtime('hub', { embedded: true }),
        authkit: hubAuthkit,
        log: (line, level) => notes.push(`${level} ${line}`),
      },
    );
    expect(Array.isArray(await consoleFor(bus, resolved.auth!).engine().workerHealth())).toBe(true);
    expect(notes).toEqual([
      'warn [@adonis-agora/durable] console commands to "shop": sending without an authkit app-call token (crypto only): connect ECONNREFUSED 127.0.0.1:3333. To attach it: grant the console\'s service client durable:console:* on "shop" in authkit.',
    ]);
  });

  it.each([
    ['authkit answered 400: invalid_target (urn:agora:app:shop)', 'info'],
    ['the app is not granted to this client', 'info'],
    ['No Grant for urn:agora:app:shop', 'info'],
    ['unauthorized_client', 'warn'],
    ['invalid_client', 'warn'],
  ] as const)('13b: "%s" is logged at %s', async (reason, level) => {
    const server = new FakeCryptoServer();
    const { bus, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    const hubAuthkit = new FakeAuthkit('hub');
    hubAuthkit.failTokens = reason;
    const notes: string[] = [];
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      {},
      {
        crypto: server.runtime('hub', { embedded: true }),
        authkit: hubAuthkit,
        log: (line, lvl) => notes.push(`${lvl} ${line}`),
      },
    );
    expect(Array.isArray(await consoleFor(bus, resolved.auth!).engine().workerHealth())).toBe(true);
    expect(notes).toHaveLength(1);
    expect(
      notes[0]?.startsWith(
        `${level} [@adonis-agora/durable] console commands to "shop": sending without`,
      ),
    ).toBe(true);
  });

  it('13b: an `invalid_target` code (no such word in the message) is a missing grant too', async () => {
    const server = new FakeCryptoServer();
    const { bus, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { embedded: true }) } },
    );
    providers.push(provider);
    const hubAuthkit = new FakeAuthkit('hub');
    const notes: string[] = [];
    const calls = hubAuthkit.appCallTokens();
    calls.token = async () => {
      throw Object.assign(new Error('authkit answered 400'), { code: 'invalid_target' });
    };
    hubAuthkit.appCallTokens = () => calls;
    const resolved = resolveConsoleSideAuth(
      'shop',
      'shop',
      {},
      {
        crypto: server.runtime('hub', { embedded: true }),
        authkit: hubAuthkit,
        log: (line, lvl) => notes.push(`${lvl} ${line}`),
      },
    );
    expect(Array.isArray(await consoleFor(bus, resolved.auth!).engine().workerHealth())).toBe(true);
    expect(notes[0]?.startsWith('info ')).toBe(true);
  });

  it('13b: in token mode the token is required, and its failure names the grant', async () => {
    const directory = new FakeKeyDirectory();
    directory.keys.set('shop/console:durable', {
      kty: 'OKP',
      crv: 'X25519',
      x: consoleCommandPublicKey(APP_KEY, 'shop'),
    });
    const hubAuthkit = new FakeAuthkitWithDirectory('hub', directory);
    hubAuthkit.failTokens = '503 invalid_target';
    const resolved = resolveConsoleSideAuth('shop', 'shop', {}, { authkit: hubAuthkit });
    const bus = new RedisBus();
    await expect(consoleFor(bus, resolved.auth!).engine().workerHealth()).rejects.toThrow(
      /503 invalid_target\. To attach it: grant the console's service client durable:console:\* on "shop" in authkit\./,
    );
  });

  it('13e: the token key is published only when crypto does not suffice (explicit crypto + verifyTenant)', async () => {
    const server = new FakeCryptoServer();
    // Automatic crypto (+ authkit's app-call verifier): crypto is enough, nothing published.
    const quiet = new FakeKeyDirectory();
    const auto = await boot(
      true,
      {},
      {
        bindings: {
          'agora.crypto': server.runtime('shop', { embedded: true }),
          'authkit.client': new FakeAuthkitWithDirectory('shop', quiet),
        },
      },
    );
    providers.push(auto.provider);
    await settle();
    expect(quiet.keys.size).toBe(0);

    // Explicit crypto that must carry a token (verifyTenant, migrating): published, like config.
    const migrating = new FakeKeyDirectory();
    const verifyTenant: TenantVerifier = () => null;
    const required = await boot(
      {
        crypto: { cipher: appConsoleCipher(server.runtime('shop', { embedded: true })) },
        verifyTenant,
        partition: 'shop',
      },
      {},
      { bindings: { 'authkit.client': new FakeAuthkitWithDirectory('shop', migrating) } },
    );
    providers.push(required.provider);
    await settle();
    expect([...migrating.keys.keys()]).toEqual(['shop/console:durable']);
    expect(
      required.lines.filter((l) => /token mode is this app's only way to be reached/.test(l)),
    ).toEqual([]);
  });

  it('13e: a crypto app says nothing about publishing a key; a token-only app warns', async () => {
    const server = new FakeCryptoServer();
    const crypto = await boot(
      true,
      {},
      {
        bindings: {
          'agora.crypto': server.runtime('shop', { embedded: true }),
          'authkit.client': new FakeAuthkit('shop'),
        },
      },
    );
    providers.push(crypto.provider);
    expect(crypto.lines.filter((l) => l.startsWith('warn'))).toEqual([]);

    const verifyTenant: TenantVerifier = () => null;
    const tokenOnly = await boot(
      { verifyTenant, partition: 'shop' },
      {},
      { bindings: { 'authkit.client': new FakeAuthkit('shop') } },
    );
    providers.push(tokenOnly.provider);
    expect(
      tokenOnly.lines.filter(
        (l) => l.startsWith('warn') && /token mode is this app's only way to be reached/.test(l),
      ),
    ).toHaveLength(1);
  });

  it('13f: hasKey checks the key without a decrypt (no audit noise); missing is info; refused warns', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const present = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { hasKey: 'yes' }) } },
    );
    providers.push(present.provider);
    await settle();
    expect(present.lines.filter((l) => l.includes('crypto key'))).toEqual([]);
    expect(server.audit.filter((a) => a.op === 'decrypt')).toEqual([]);
    expect(server.audit.filter((a) => a.op === 'hasKey')).toHaveLength(1);

    const empty = new FakeCryptoServer();
    const missing = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': empty.runtime('shop', { hasKey: 'yes' }) } },
    );
    providers.push(missing.provider);
    await settle();
    expect(
      missing.lines.filter((l) => /^info .*does not exist in partition shop yet/.test(l)),
    ).toHaveLength(1);

    const refused = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { hasKey: 'yes', refuse: true }) } },
    );
    providers.push(refused.provider);
    await settle();
    expect(
      refused.lines.filter((l) => l.startsWith('warn') && /refused this app/.test(l)),
    ).toHaveLength(1);
  });

  it('13f: an older crypto server (hasKey throws, not forbidden) falls back to the decrypt probe', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const { lines, provider } = await boot(
      true,
      {},
      { bindings: { 'agora.crypto': server.runtime('shop', { hasKey: 'old' }) } },
    );
    providers.push(provider);
    await settle();
    // The probe ran (the key is usable: no line), and nothing was taken as a refusal.
    expect(lines.filter((l) => l.includes('crypto key') || /refused this app/.test(l))).toEqual([]);
  });
});

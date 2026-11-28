import { describe, expect, it } from 'vitest';
import type { CryptoRuntimeLike } from '../../src/control-plane-redis/console-crypto.js';
import { resolveMessageSealer } from '../../src/messages/resolve.js';
import {
  appKeyRoot,
  CONTROL_PLANE_KEYS_PARTITION,
  handshakeKeyPair,
  openGrant,
} from '../../src/messages/tenant-keys.js';
import { FakeCryptoServer } from '../support/fake-crypto-runtime.js';

/**
 * The durable control plane's `durable-message-keys` key (1.5.2): never touched at boot, resolved on
 * the first key request, kept in `_durable` when the app's crypto is a control plane itself (no app
 * of its own: partition `''`, which crypto refuses), and HKDF over APP_KEY with one warning when
 * crypto cannot give it.
 */

const CP_KEY = 'control-plane-app-key-0123456789abcd';
const KEY = 'durable-message-keys';
const DOCS = 'https://davidecarvalho.github.io/agora/docs/durable/transports/encrypting-messages';

function appWith(options: {
  seal: boolean;
  appKey?: string | undefined;
  runtime?: unknown;
}): unknown {
  return {
    container: {
      hasBinding: (b: string) => b === 'agora.crypto' && options.runtime !== undefined,
      make: async () => options.runtime,
    },
    config: {
      get: (key: string) =>
        key === 'durable'
          ? { topology: 'control-plane', ...(options.seal ? { messages: { seal: true } } : {}) }
          : key === 'app.appKey'
            ? options.appKey
            : undefined,
    },
  };
}

/** Every call the control plane makes on crypto, whatever the surface. */
function counted(runtime: CryptoRuntimeLike): { runtime: CryptoRuntimeLike; calls: string[] } {
  const calls: string[] = [];
  const wrap = <T extends object>(target: T, prefix: string): T =>
    new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (prop === 'store' && value && typeof value === 'object') {
          return wrap(value as object, `${prefix}store.`);
        }
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(`${prefix}${String(prop)}`);
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      },
    });
  return {
    runtime: {
      ...runtime,
      ...(runtime.service ? { service: wrap(runtime.service, 'service.') } : {}),
      operations: wrap(runtime.operations, 'operations.'),
    },
    calls,
  };
}

async function controlPlane(options: {
  seal: boolean;
  runtime: CryptoRuntimeLike;
  appKey?: string;
  name?: string;
  lines?: string[];
}) {
  const lines = options.lines ?? [];
  const sealer = await resolveMessageSealer(
    {
      app: appWith({
        seal: options.seal,
        appKey: options.appKey,
        runtime: options.runtime,
      }) as never,
      name: options.name ?? 'bullmq',
      log: (level, line) => lines.push(`${level}: ${line}`),
    },
    {},
  );
  // Anything fired in the background at boot would have landed by now.
  await new Promise((r) => setTimeout(r, 20));
  return { sealer, lines };
}

const task = {
  runId: 'r',
  seq: 0,
  stepId: 'r:0',
  name: 'pay',
  group: 'pay@acme',
  input: { card: 'secret' },
  attempt: 1,
};
const kidOf = (m: unknown) => String((m as { sealed: string }).sealed).split('.')[3];
const warnings = (lines: string[]) => lines.filter((l) => l.startsWith('warn:'));

describe('the control plane key at boot', () => {
  it('sealing off on a crypto control plane: no crypto call and no warning', async () => {
    const server = new FakeCryptoServer();
    const { runtime, calls } = counted(server.controlPlane());
    const { lines } = await controlPlane({ seal: false, runtime, appKey: CP_KEY });
    expect(calls).toEqual([]);
    expect(server.audit).toEqual([]);
    expect(warnings(lines)).toEqual([]);
    expect(lines).toEqual([
      `info: [@adonis-agora/durable] bullmq messages: sent plain, sealed ones opened with control plane keys (crypto, key ${KEY}, partition _durable). Once every process runs 1.2.1 or later, turn sealing on: \`messages: { seal: true }\` in config/durable.ts. Docs: ${DOCS}`,
    ]);
  });

  it('sealing off with a crypto that cannot create the key: still nothing at boot', async () => {
    const server = new FakeCryptoServer();
    const base = server.controlPlane();
    const broken: CryptoRuntimeLike = {
      ...base,
      service: {
        ...(base.service as NonNullable<CryptoRuntimeLike['service']>),
        createKey: async () => {
          throw new Error('database is down');
        },
      },
    };
    const { runtime, calls } = counted(broken);
    const { lines } = await controlPlane({ seal: false, runtime, appKey: CP_KEY });
    expect(calls).toEqual([]);
    expect(warnings(lines)).toEqual([]);
  });

  it('sealing on: still no crypto call until the first key request', async () => {
    const server = new FakeCryptoServer();
    const { runtime, calls } = counted(server.controlPlane());
    const { lines } = await controlPlane({ seal: true, runtime, appKey: CP_KEY });
    expect(calls).toEqual([]);
    expect(lines).toEqual([
      `info: [@adonis-agora/durable] bullmq messages: control plane keys (crypto, key ${KEY}, partition _durable)`,
    ]);
  });
});

describe('the control plane key on first use', () => {
  it('is created on the first seal, in `_durable` on a crypto control plane, then used', async () => {
    const server = new FakeCryptoServer();
    const { runtime, calls } = counted(server.controlPlane());
    const { sealer, lines } = await controlPlane({ seal: true, runtime, appKey: CP_KEY });
    expect(CONTROL_PLANE_KEYS_PARTITION).toBe('_durable');

    const sealed = await sealer.seal('task', task);
    expect(server.hasKey('_durable', KEY)).toBe(true);
    expect(server.hasKey('', KEY)).toBe(false);
    // Every crypto operation ran in `_durable`, never in the control plane's empty partition.
    expect(server.audit.length).toBeGreaterThan(0);
    expect(new Set(server.audit.map((a) => a.partition))).toEqual(new Set(['_durable']));
    expect(server.audit[0]).toMatchObject({ op: 'createKey', key: KEY, actor: 'durable:messages' });
    expect(calls.slice(0, 2)).toEqual(['service.store.getKey', 'service.createKey']);
    expect(lines).toContain(
      `info: [@adonis-agora/durable] messages: created the crypto key "${KEY}" in partition _durable`,
    );
    expect(warnings(lines)).toEqual([]);
    // Crypto's key, not the APP_KEY.
    expect(kidOf(sealed)).not.toBe(await appKeyRoot(CP_KEY).kid());
    expect(await sealer.open('task', JSON.parse(JSON.stringify(sealed)))).toEqual(task);

    // Checked once: later requests do not create or look it up again.
    const before = calls.filter((c) => c !== 'service.hmac').length;
    await sealer.seal('task', { ...task, seq: 1 });
    expect(calls.filter((c) => c !== 'service.hmac').length).toBe(before);
  });

  it('a tenant asking for its key is a first key request too; an existing key is reused', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('_durable', KEY);
    const { runtime, calls } = counted(server.controlPlane());
    const { sealer, lines } = await controlPlane({ seal: false, runtime, appKey: CP_KEY });
    expect(calls).toEqual([]);
    const issue = (sealer as { issueTenantKey?: unknown }).issueTenantKey as
      | ((input: { partition: string; publicKey: string; requestId: string }) => Promise<{
          kid: string;
          epk: string;
          ct: string;
        }>)
      | undefined;
    expect(typeof issue).toBe('function');
    const pair = handshakeKeyPair();
    const grant = await issue?.({
      partition: 'acme',
      publicKey: pair.publicKey,
      requestId: 'mk-1',
    });
    expect(grant && openGrant(grant, pair, 'mk-1', 'acme')).toHaveLength(32);
    expect(calls).toContain('service.store.getKey');
    expect(calls).not.toContain('service.createKey');
    expect(warnings(lines)).toEqual([]);
  });

  it('keeps using crypto’s own partition when crypto has one (standalone crypto app)', async () => {
    const server = new FakeCryptoServer();
    const { sealer } = await controlPlane({
      seal: true,
      runtime: server.runtime('hub', { embedded: true }),
      appKey: CP_KEY,
    });
    await sealer.seal('task', task);
    expect(server.hasKey('hub', KEY)).toBe(true);
    expect(server.hasKey('_durable', KEY)).toBe(false);
  });

  it('two transports of one control plane share the key: checked once', async () => {
    const server = new FakeCryptoServer();
    const { runtime, calls } = counted(server.controlPlane());
    const lines: string[] = [];
    const a = await controlPlane({ seal: true, runtime, appKey: CP_KEY, lines });
    const b = await controlPlane({
      seal: true,
      runtime,
      appKey: CP_KEY,
      name: 'control plane',
      lines,
    });
    await Promise.all([a.sealer.seal('task', task), b.sealer.seal('task', task)]);
    expect(calls.filter((c) => c === 'service.createKey')).toHaveLength(1);
    expect(lines.filter((l) => l.includes('created the crypto key'))).toHaveLength(1);
  });
});

describe('the fallback to APP_KEY', () => {
  function brokenCrypto(error = 'database is down') {
    const server = new FakeCryptoServer();
    const base = server.controlPlane();
    const service = base.service as NonNullable<CryptoRuntimeLike['service']>;
    const runtime: CryptoRuntimeLike = {
      ...base,
      service: {
        ...service,
        createKey: async () => {
          throw new Error(error);
        },
      },
    };
    return { server, runtime };
  }

  const fallbackLine = (reason: string) =>
    `warn: [@adonis-agora/durable] messages: the control plane cannot use the crypto key "${KEY}" in partition _durable (${reason}), so this process derives its tenants' message keys from its APP_KEY (HKDF) instead. Every replica of the control plane must derive them the same way: create it: \`node ace crypto:keys:create ${KEY} --type hmac-sha256 --application _durable\`, then restart. Docs: ${DOCS}`;

  it('when crypto cannot create the key: one warning, and the APP_KEY root seals', async () => {
    const { runtime } = brokenCrypto();
    const { sealer, lines } = await controlPlane({ seal: true, runtime, appKey: CP_KEY });
    expect(warnings(lines)).toEqual([]);
    const sealed = await sealer.seal('task', task);
    expect(kidOf(sealed)).toBe(await appKeyRoot(CP_KEY).kid());
    expect(await sealer.open('task', JSON.parse(JSON.stringify(sealed)))).toEqual(task);
    await sealer.seal('task', { ...task, seq: 1 });
    expect(warnings(lines)).toEqual([fallbackLine('database is down')]);
  });

  it('a crypto tenant without the grants: the warning names the grant', async () => {
    const server = new FakeCryptoServer();
    const runtime = server.runtime('hub', { grants: [], hasKey: 'yes' });
    const { sealer, lines } = await controlPlane({ seal: true, runtime, appKey: CP_KEY });
    const sealed = await sealer.seal('task', task);
    expect(kidOf(sealed)).toBe(await appKeyRoot(CP_KEY).kid());
    expect(warnings(lines)).toEqual([
      `warn: [@adonis-agora/durable] messages: the control plane cannot use the crypto key "${KEY}" in partition hub (forbidden: crypto:keys:manage:${KEY}), so this process derives its tenants' message keys from its APP_KEY (HKDF) instead. Every replica of the control plane must derive them the same way: create it on the crypto server (\`node ace crypto:keys:create ${KEY} --type hmac-sha256 --application hub\`) and grant this app's crypto client \`crypto:hmac:${KEY}\` (or \`crypto:keys:manage:${KEY}\` so it creates it), then restart. Docs: ${DOCS}`,
    ]);
  });

  it('without an APP_KEY either: the seal fails, said once, retried on the next request', async () => {
    const { server, runtime } = brokenCrypto();
    const { sealer, lines } = await controlPlane({ seal: true, runtime });
    await expect(sealer.seal('task', task)).rejects.toThrow(/cannot use the crypto key/);
    await expect(sealer.seal('task', task)).rejects.toThrow(/cannot use the crypto key/);
    expect(warnings(lines)).toHaveLength(1);
    expect(warnings(lines)[0]).toContain('and this app has no APP_KEY to fall back to');
    // Fixed meanwhile (the key created by hand): the next request uses it.
    server.createKeyIn('_durable', KEY);
    const sealed = await sealer.seal('task', task);
    expect(await sealer.open('task', JSON.parse(JSON.stringify(sealed)))).toEqual(task);
  });
});

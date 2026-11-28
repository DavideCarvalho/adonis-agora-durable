import { afterEach, describe, expect, it } from 'vitest';
import { describeMessagesMode, resolveMessageSealer } from '../../src/messages/resolve.js';
import { backendUrl } from '../support/backends.js';
import { FakeCryptoServer } from '../support/fake-crypto-runtime.js';

/**
 * The explicit modes, the boot lines, and what happens without a way to get a key. The tenant ↔
 * control-plane keys have their own spec (control-plane-keys.spec.ts).
 */

const _REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const TENANT_GRANTS = [
  'crypto:encrypt:durable-messages',
  'crypto:decrypt:durable-messages',
  'crypto:keys:manage:durable-messages',
];

function appWith(options: {
  topology: string;
  runtime?: unknown;
  appKey?: string;
  seal?: boolean;
}): unknown {
  return {
    container: {
      hasBinding: (b: string) => b === 'agora.crypto' && options.runtime !== undefined,
      make: async () => options.runtime,
    },
    config: {
      get: (key: string) =>
        key === 'durable'
          ? { topology: options.topology, messages: { seal: options.seal ?? true } }
          : key === 'app.appKey'
            ? options.appKey
            : undefined,
    },
  };
}

async function build(app: unknown, name = 'bullmq', options = {}) {
  const lines: string[] = [];
  const sealer = await resolveMessageSealer(
    { app: app as never, name, log: (level, line) => lines.push(`${level}: ${line}`) },
    options,
  );
  return { sealer, lines };
}

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const previousEnv = process.env.APP_KEY;
afterEach(() => {
  if (previousEnv === undefined) delete process.env.APP_KEY;
  else process.env.APP_KEY = previousEnv;
});

describe('explicit modes and boot lines', () => {
  it('an explicit cipher wins over the automatic mode', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shared', 'relay-key');
    const explicit = server.runtime('shared', {
      grants: ['crypto:encrypt:relay-key', 'crypto:decrypt:relay-key'],
    });
    const app = appWith({
      topology: 'tenant',
      runtime: server.runtime('acme', { grants: TENANT_GRANTS }),
    });
    const { sealer, lines } = await build(app, 'bullmq', {
      crypto: { cipher: () => explicit.operations, key: 'relay-key' },
    });
    expect(lines).toContain(
      'info: [@adonis-agora/durable] bullmq messages: crypto (key relay-key)',
    );
    const other = await build(appWith({ topology: 'control-plane' }), 'bullmq', {
      crypto: { cipher: explicit.operations, key: 'relay-key' },
    });
    const msg = { runId: 'r', seq: 1, stepId: 'r:1', status: 'completed', output: 'x' };
    expect(await other.sealer.open('result', wire(await sealer.seal('result', msg)))).toEqual(msg);
  });

  it('between apps without a way to get a key: plain, with one warning naming the fix', async () => {
    const tenant = await build(
      appWith({ topology: 'tenant', appKey: 'an-app-key-0123456789abcdef' }),
    );
    expect(tenant.sealer.mode).toBe('plain');
    expect(tenant.lines.join('\n')).toMatch(
      /plain \(no tenant token\): not sealed; a tenant pod gets its message key from the control plane/,
    );
    delete process.env.APP_KEY;
    const cp = await build(appWith({ topology: 'control-plane' }));
    expect(cp.sealer.mode).toBe('plain');
    expect(cp.lines.join('\n')).toMatch(/derives its tenants' message keys from its APP_KEY/);
  });

  it('two apps sharing a transport without a control plane: refused, with the fix named', async () => {
    const a = await build(
      appWith({ topology: 'standalone', appKey: 'app-a-key-0123456789abcdefgh' }),
    );
    const b = await build(
      appWith({ topology: 'standalone', appKey: 'app-b-key-0123456789abcdefgh' }),
    );
    const sealed = wire(
      await a.sealer.seal('task', {
        runId: 'r',
        seq: 0,
        stepId: 'r:0',
        name: 'x',
        group: 'x',
        input: 1,
        attempt: 1,
      }),
    );
    await expect(b.sealer.open('task', sealed)).rejects.toThrow(
      /another app shares this transport/,
    );
    expect(b.lines.join('\n')).toMatch(/messages: \{ secret \}/);
  });

  it('one app: the APP_KEY mode, `crypto: false` and `insecure` turn it off, with a warning', async () => {
    const app = appWith({ topology: 'standalone', appKey: 'an-app-key-0123456789abcdef' });
    expect((await build(app)).lines).toEqual([
      'info: [@adonis-agora/durable] bullmq messages: app key (auto)',
    ]);
    expect((await build(app, 'bullmq', { acceptPlain: false })).lines).toEqual([
      'info: [@adonis-agora/durable] bullmq messages: app key (auto), plain messages refused',
    ]);
    const off = await build(app, 'bullmq', { crypto: false });
    expect(off.sealer.mode).toBe('plain');
    expect(off.lines[0]).toMatch(/^warn: .*bullmq messages: plain \(crypto: false\): not sealed/);
    const insecure = await build(app, 'bullmq', { insecure: true });
    expect(insecure.lines[0]).toMatch(/plain \(insecure\): not sealed/);
    delete process.env.APP_KEY;
    const noKey = await build(appWith({ topology: 'standalone' }));
    expect(noKey.sealer.mode).toBe('plain');
    expect(noKey.lines[0]).toMatch(/plain \(no APP_KEY\): not sealed; set APP_KEY/);
    expect(await describeMessagesMode(app as never, 'bullmq')).toMatchObject({ mode: 'app-key' });
    await expect(
      build(app, 'bullmq', { insecure: true, secret: 'a-shared-secret-of-16+' }),
    ).rejects.toThrow(/one of `secret`, `crypto` or `insecure`/);
  });
});

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask, StepResult } from '../../src/interfaces.js';
import { describeMessagesMode, resolveMessageSealer } from '../../src/messages/resolve.js';
import type { MessageSealer } from '../../src/messages/sealer.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { backendUrl } from '../support/backends.js';
import { FakeCryptoServer } from '../support/fake-crypto-runtime.js';

/**
 * Between a tenant and its control plane (two apps, no shared APP_KEY), messages are sealed with the
 * `durable-messages` key of the tenant's partition in `@adonis-agora/crypto`, found structurally
 * (`agora.crypto` binding): the control plane (crypto embedded) seals and opens in each tenant's
 * partition; a tenant only in its own.
 */

const REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const TENANT_GRANTS = [
  'crypto:encrypt:durable-messages',
  'crypto:decrypt:durable-messages',
  'crypto:keys:manage:durable-messages',
];

function appWith(options: { topology: string; runtime?: unknown; appKey?: string }): unknown {
  return {
    container: {
      hasBinding: (b: string) => b === 'agora.crypto' && options.runtime !== undefined,
      make: async () => options.runtime,
    },
    config: {
      get: (key: string) =>
        key === 'durable'
          ? { topology: options.topology }
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

describe('messages across apps with @adonis-agora/crypto', () => {
  async function fleet() {
    const server = new FakeCryptoServer();
    const hub = await build(
      appWith({ topology: 'control-plane', runtime: server.runtime('hub', { embedded: true }) }),
    );
    const acme = await build(
      appWith({
        topology: 'tenant',
        runtime: server.runtime('acme', { grants: TENANT_GRANTS, hasKey: 'yes' }),
      }),
    );
    const globex = await build(
      appWith({
        topology: 'tenant',
        runtime: server.runtime('globex', { grants: TENANT_GRANTS, hasKey: 'yes' }),
      }),
    );
    // The tenants' boot check creates their key (their token may manage it).
    await new Promise((r) => setTimeout(r, 20));
    return { server, hub, acme, globex };
  }

  it('resolves crypto automatically on both sides and says so at boot', async () => {
    const { hub, acme, server } = await fleet();
    expect(hub.sealer.mode).toBe('crypto');
    expect(hub.lines).toContain(
      'info: [@adonis-agora/durable] bullmq messages: crypto (auto, key durable-messages, partition hub)',
    );
    expect(acme.lines).toContain(
      'info: [@adonis-agora/durable] bullmq messages: crypto (auto, key durable-messages, partition acme)',
    );
    expect(
      acme.lines.some((l) =>
        l.includes('created the crypto key "durable-messages" in partition acme'),
      ),
    ).toBe(true);
    expect(server.hasKey('acme', 'durable-messages')).toBe(true);
  });

  it('tenant → control plane: a run request opens on the hub, its reply goes back sealed for that tenant', async () => {
    const { hub, acme, globex } = await fleet();
    const request = {
      requestId: 'req-1',
      tenant: 'token-of-acme',
      body: { kind: 'getRun', runId: 'r' },
    };
    const sealed = wire(await acme.sealer.seal('runRequest', request));
    expect(JSON.stringify(sealed)).not.toContain('token-of-acme');
    expect(await hub.sealer.open('runRequest', sealed)).toEqual(request);

    const reply = { requestId: 'req-1', result: { ok: true, data: 'the run of acme' } };
    const sealedReply = wire(await hub.sealer.seal('runReply', reply));
    expect(await acme.sealer.open('runReply', sealedReply)).toEqual(reply);
    // Another tenant cannot open it.
    await expect(globex.sealer.open('runReply', sealedReply)).rejects.toMatchObject({
      reason: 'unauthenticated',
    });
  });

  it('control plane → tenant: a task for `name@acme` is sealed in acme’s partition (key created by the hub)', async () => {
    const server = new FakeCryptoServer();
    const hub = await build(
      appWith({ topology: 'control-plane', runtime: server.runtime('hub', { embedded: true }) }),
    );
    const task: RemoteTask = {
      runId: 'r',
      seq: 0,
      stepId: 'r:0',
      name: 'pay',
      group: 'pay@acme',
      input: { card: 'secret-card' },
      attempt: 1,
    };
    const sealed = wire(await hub.sealer.seal('task', task));
    expect(server.hasKey('acme', 'durable-messages')).toBe(true);
    expect(
      hub.lines.some((l) =>
        l.includes('created the crypto key "durable-messages" in partition acme'),
      ),
    ).toBe(true);
    const acme = await build(
      appWith({ topology: 'tenant', runtime: server.runtime('acme', { grants: TENANT_GRANTS }) }),
    );
    expect(await acme.sealer.open('task', sealed)).toEqual(task);
    const globex = await build(
      appWith({ topology: 'tenant', runtime: server.runtime('globex', { grants: TENANT_GRANTS }) }),
    );
    await expect(globex.sealer.open('task', sealed)).rejects.toMatchObject({
      reason: 'unauthenticated',
    });
  });

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

  it('without crypto between apps: plain, with one warning naming the fix', async () => {
    const { sealer, lines } = await build(
      appWith({ topology: 'tenant', appKey: 'an-app-key-0123456789abcdef' }),
    );
    expect(sealer.mode).toBe('plain');
    expect(lines.join('\n')).toMatch(
      /bullmq messages: plain \(no @adonis-agora\/crypto\): not sealed; between a tenant and its control plane/,
    );
    const cp = await build(
      appWith({
        topology: 'control-plane',
        runtime: new FakeCryptoServer().runtime('hub', { grants: [] }),
      }),
    );
    expect(cp.sealer.mode).toBe('plain');
    expect(cp.lines.join('\n')).toMatch(/crypto embedded in this app/);
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

describe.skipIf(!REDIS_URL)(
  'a tenant pod and its control plane over BullMQ, sealed with crypto',
  () => {
    const closers: Array<() => Promise<unknown>> = [];
    afterEach(async () => {
      for (const c of closers.splice(0)) await c().catch(() => undefined);
    });

    it('runs a step for the tenant end to end, sealed in the partition of the tenant', async () => {
      const server = new FakeCryptoServer();
      const hub = (
        await build(
          appWith({
            topology: 'control-plane',
            runtime: server.runtime('hub', { embedded: true }),
          }),
        )
      ).sealer as MessageSealer;
      const acme = (
        await build(
          appWith({
            topology: 'tenant',
            runtime: server.runtime('acme', { grants: TENANT_GRANTS }),
          }),
        )
      ).sealer as MessageSealer;
      await new Promise((r) => setTimeout(r, 20));
      const prefix = `dmsg-${randomUUID().slice(0, 8)}`;
      const connection = { url: REDIS_URL } as unknown;
      const cp = new BullMQTransport({
        deps: await createBullMQDeps(connection),
        prefix,
        messages: hub,
        pingIntervalMs: false,
      });
      const pod = new BullMQTransport({
        deps: await createBullMQDeps(connection),
        prefix,
        partition: 'acme',
        messages: acme,
        pingIntervalMs: false,
      });
      closers.push(
        () => cp.close(),
        () => pod.close(),
      );
      const seen: unknown[] = [];
      pod.handle('pay', async (input) => {
        seen.push(input);
        return { receipt: 'receipt-secret' };
      });
      const results: StepResult[] = [];
      cp.onResult(async (r) => {
        results.push(r);
      });
      await cp.dispatch({
        runId: 'r',
        seq: 0,
        stepId: 'r:0',
        name: 'pay',
        group: 'pay@acme',
        input: { card: 'card-secret' },
        attempt: 1,
      });
      const deadline = Date.now() + 15_000;
      while (results.length === 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([{ card: 'card-secret' }]);
      expect(results[0]).toMatchObject({
        status: 'completed',
        output: { receipt: 'receipt-secret' },
      });
      expect(server.audit.some((e) => e.partition === 'acme' && e.key === 'durable-messages')).toBe(
        true,
      );
    });
  },
);

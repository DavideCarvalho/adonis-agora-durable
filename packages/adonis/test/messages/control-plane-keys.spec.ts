import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunReply, RunRequest, StartRunMessage, StepResult } from '../../src/interfaces.js';
import { resolveMessageSealer } from '../../src/messages/resolve.js';
import { createMessageSealer, type MessageSealer } from '../../src/messages/sealer.js';
import {
  appKeyRoot,
  cryptoRoot,
  grantKey,
  handshakeKeyPair,
  MESSAGE_KEY_REQUEST,
  openGrant,
} from '../../src/messages/tenant-keys.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { backendUrl } from '../support/backends.js';
import { FakeCryptoServer } from '../support/fake-crypto-runtime.js';

/**
 * Between tenant pods and their control plane, the CONTROL PLANE owns the message keys: one per
 * tenant partition, derived from its crypto key `durable-message-keys` (crypto embedded, or a crypto
 * server it is a tenant of) or from its APP_KEY; handed to each pod on a `messageKey` request
 * authenticated with the pod's token, sealed to the pod's ephemeral X25519 key. Tenants need no
 * crypto and share nothing.
 */

const REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const CP_KEY = 'control-plane-app-key-0123456789abcd';
const ACME_KEY = 'acme-app-key-0123456789abcdefghijk';
const GLOBEX_KEY = 'globex-app-key-0123456789abcdefghij';
const TOKENS: Record<string, string> = { 'tok-acme': 'acme', 'tok-globex': 'globex' };

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The partition a test token verifies to (`tok-acme#3` → acme). */
function verified(token: string | undefined, capabilities: string[]) {
  const base = token?.split('#')[0];
  return base && TOKENS[base] ? { partition: TOKENS[base] as string, capabilities } : null;
}
const quiet = () => undefined;

function appWith(options: { topology: string; appKey?: string; runtime?: unknown }): unknown {
  return {
    container: {
      hasBinding: (b: string) => b === 'agora.crypto' && options.runtime !== undefined,
      make: async () => options.runtime,
    },
    config: {
      get: (key: string) =>
        key === 'durable'
          ? { topology: options.topology, messages: { seal: true } }
          : key === 'app.appKey'
            ? options.appKey
            : undefined,
    },
  };
}

type CpVariant = 'app key' | 'crypto embedded' | 'crypto control plane' | 'crypto separate';

async function controlPlaneSealer(variant: CpVariant, server = new FakeCryptoServer()) {
  const lines: string[] = [];
  const runtime =
    variant === 'crypto embedded'
      ? server.runtime('hub', { embedded: true })
      : variant === 'crypto control plane'
        ? server.controlPlane()
        : variant === 'crypto separate'
          ? server.runtime('hub', {
              grants: [
                'crypto:hmac:durable-message-keys',
                'crypto:keys:manage:durable-message-keys',
              ],
              hasKey: 'yes',
            })
          : undefined;
  const sealer = await resolveMessageSealer(
    {
      app: appWith({ topology: 'control-plane', appKey: CP_KEY, runtime }) as never,
      name: 'bullmq',
      log: (level, line) => lines.push(`${level}: ${line}`),
    },
    {},
  );
  return { sealer, lines, server };
}

async function tenantSealer(partition: string, appKey: string, token: string) {
  const lines: string[] = [];
  let minted = 1;
  const sealer = await resolveMessageSealer(
    {
      app: appWith({ topology: 'tenant', appKey }) as never,
      name: 'bullmq',
      log: (level, line) => lines.push(`${level}: ${line}`),
      // A fresh token per reset, like authkit app-call tokens (`tok-acme#1`, `tok-acme#2`, …).
      tenant: {
        partition,
        token: async () => `${token}#${minted}`,
        resetToken: () => {
          minted += 1;
        },
      },
    },
    {},
  );
  return { sealer, lines };
}

describe('the control plane derives each tenant partition’s key', () => {
  it('from its APP_KEY: deterministic across replicas, one key per partition', async () => {
    const a = appKeyRoot(CP_KEY);
    const b = appKeyRoot(CP_KEY);
    const acme = await a.current('acme');
    expect((await b.current('acme')).key.equals(acme.key)).toBe(true);
    expect((await a.current('globex')).key.equals(acme.key)).toBe(false);
    expect(await a.byKid('acme', 'some-other-kid')).toBeUndefined();
    expect((await appKeyRoot(GLOBEX_KEY).current('acme')).kid).not.toBe(acme.kid);
  });

  it('from crypto: a rotation is a new kid, and the previous one still opens in this process', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('hub', 'durable-message-keys');
    const principal = {
      partition: 'hub',
      capabilities: ['crypto:hmac:durable-message-keys'],
      actor: 'test',
    };
    let now = 0;
    const root = cryptoRoot(
      async (message) => server.hmacFor(principal, { key: 'durable-message-keys', message }).hmac,
      () => now,
    );
    const before = await root.current('acme');
    server.rotate('hub', 'durable-message-keys');
    now += 10 * 60_000; // past the kid refresh
    const after = await root.current('acme');
    expect(after.kid).not.toBe(before.kid);
    expect(after.key.equals(before.key)).toBe(false);
    expect((await root.byKid('acme', before.kid))?.equals(before.key)).toBe(true);
  });
});

describe('the key handshake', () => {
  it('only the pod that asked opens its key; a grant replayed into another request does not open', () => {
    const key = Buffer.alloc(32, 7);
    const pod = handshakeKeyPair();
    const attacker = handshakeKeyPair();
    const grant = grantKey(
      { publicKey: pod.publicKey, requestId: 'mk-1', partition: 'acme', kid: 'k1' },
      key,
    );
    expect(openGrant(grant, pod, 'mk-1', 'acme')?.equals(key)).toBe(true);
    expect(openGrant(grant, attacker, 'mk-1', 'acme')).toBeNull();
    expect(openGrant(grant, pod, 'mk-2', 'acme')).toBeNull();
    expect(openGrant(grant, pod, 'mk-1', 'globex')).toBeNull();
    expect(openGrant({ ...grant, kid: 'k2' }, pod, 'mk-1', 'acme')).toBeNull();
  });
});

describe.skipIf(!REDIS_URL)('two apps through the durable control plane, over BullMQ', () => {
  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
  });

  interface RawRedis {
    keys(p: string): Promise<string[]>;
    type(k: string): Promise<string>;
    hgetall(k: string): Promise<Record<string, string>>;
    lrange(k: string, a: number, b: number): Promise<string[]>;
    zrange(k: string, a: number, b: number): Promise<string[]>;
    get(k: string): Promise<string | null>;
    psubscribe(p: string): Promise<unknown>;
    on(e: string, fn: (...args: string[]) => void): unknown;
    quit(): Promise<unknown>;
  }

  async function raw(): Promise<RawRedis> {
    const r = (
      await createBullMQDeps({ url: REDIS_URL } as unknown)
    ).makeRedis() as unknown as RawRedis;
    closers.push(() => r.quit());
    return r;
  }

  async function dump(r: RawRedis, prefix: string): Promise<string> {
    const out: string[] = [];
    for (const key of await r.keys(`*${prefix}*`)) {
      const type = await r.type(key);
      if (type === 'hash') out.push(JSON.stringify(await r.hgetall(key)));
      else if (type === 'list') out.push(JSON.stringify(await r.lrange(key, 0, -1)));
      else if (type === 'zset') out.push(JSON.stringify(await r.zrange(key, 0, -1)));
      else if (type === 'string') out.push(String(await r.get(key)));
    }
    return out.join('\n');
  }

  async function transport(prefix: string, messages: MessageSealer, partition?: string) {
    const t = new BullMQTransport({
      deps: await createBullMQDeps({ url: REDIS_URL } as unknown),
      prefix,
      messages,
      pingIntervalMs: false,
      ...(partition ? { partition } : {}),
    });
    closers.push(() => t.close());
    return t;
  }

  async function until(cond: () => boolean, budgetMs = 15_000) {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > budgetMs) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  for (const variant of [
    'app key',
    'crypto embedded',
    'crypto control plane',
    'crypto separate',
  ] as const) {
    it(`${variant}: app A starts a workflow whose step runs on app B; nothing readable on Redis`, async () => {
      const prefix = `dmsg-cpk-${randomUUID().slice(0, 8)}`;
      const redis = await raw();
      const published: string[] = [];
      const sub = await raw();
      sub.on('pmessage', (_p: string, _c: string, m: string) => published.push(m));
      await sub.psubscribe(`${prefix}*`);

      const cp = await controlPlaneSealer(variant);
      // The key's partition: crypto's own, or `_durable` on a crypto control plane (no app of its own).
      const keysPartition = variant === 'crypto control plane' ? '_durable' : 'hub';
      if (variant !== 'app key') {
        // Nothing is asked of crypto at boot: the key is checked on the first key request.
        expect(cp.server.audit).toEqual([]);
        expect(cp.lines.join('\n')).toMatch(
          new RegExp(
            `control plane keys \\(crypto, key durable-message-keys, partition ${keysPartition}\\)`,
          ),
        );
      } else {
        expect(cp.lines.join('\n')).toMatch(/control plane keys \(app key\)/);
      }
      const acme = await tenantSealer('acme', ACME_KEY, 'tok-acme');
      const globex = await tenantSealer('globex', GLOBEX_KEY, 'tok-globex');
      const cpT = await transport(prefix, cp.sealer);
      const acmeT = await transport(prefix, acme.sealer, 'acme');
      const globexT = await transport(prefix, globex.sealer, 'globex');

      // The control plane: answers requests, and runs A's workflow by dispatching its step to B.
      const secret = `secret-${randomUUID().slice(0, 6)}`;
      const results: StepResult[] = [];
      cpT.onResult(async (r) => {
        results.push(r);
      });
      const starts: StartRunMessage[] = [];
      const gateway = {
        start: async (_workflow: string, input: unknown) => {
          await cpT.dispatch({
            runId: 'run-ab',
            seq: 0,
            stepId: 'run-ab:0',
            name: 'billing.charge',
            group: 'billing.charge@globex',
            input,
            attempt: 1,
          });
          return { runId: 'run-ab' };
        },
      };
      new RunRequestResponder(cpT, gateway as never, {
        verifyTenant: async ({ token }) => verified(token, ['*']),
      }).start();
      cpT.onStartRun(async (m) => {
        starts.push(m);
      });

      const charged: unknown[] = [];
      globexT.handle('billing.charge', async (input) => {
        charged.push(input);
        return { receipt: `${secret}-receipt` };
      });
      const replies: RunReply[] = [];
      acmeT.onRunReply((r) => replies.push(r));

      await acmeT.dispatchStartRun({
        tenant: 'tok-acme',
        workflow: 'globex.checkout',
        input: { card: `${secret}-card` },
        runId: 'run-ab',
      });
      await until(() => results.length > 0 && replies.some((r) => r.requestId === 'run-ab'));
      expect(charged).toEqual([{ card: `${secret}-card` }]);
      expect(results[0]).toMatchObject({
        status: 'completed',
        output: { receipt: `${secret}-receipt` },
      });
      expect(replies.find((r) => r.requestId === 'run-ab')?.result).toEqual({
        ok: true,
        data: { runId: 'run-ab' },
      });

      const onBroker = `${await dump(redis, prefix)}\n${published.join('\n')}`;
      expect(onBroker).not.toContain(secret);
      expect(onBroker).not.toContain('tok-acme');
      expect(onBroker).toMatch(/dm1\.t\./);
      // Neither tenant has crypto; both got their key from the control plane.
      expect(acme.lines.join('\n')).toMatch(
        /control plane key \(partition acme, asked over the broker\)/,
      );
      if (variant !== 'app key') {
        expect(cp.server.hasKey(keysPartition, 'durable-message-keys')).toBe(true);
        expect(cp.lines.filter((l) => l.startsWith('warn:'))).toEqual([]);
      }
    });
  }

  it('refuses a key to a wrong token, a token of another partition, and a stale request', async () => {
    const prefix = `dmsg-cpk-${randomUUID().slice(0, 8)}`;
    const cp = await controlPlaneSealer('app key');
    const cpT = await transport(prefix, cp.sealer);
    new RunRequestResponder(cpT, {} as never, {
      verifyTenant: async ({ token }) => verified(token, []),
    }).start();
    // A raw client (plain): it sees every key answer, as an eavesdropper on the broker would.
    const probe = await transport(prefix, createMessageSealer({ mode: 'plain' }), 'acme');
    const replies: RunReply[] = [];
    probe.onRunReply((r) => replies.push(r));
    const pair = handshakeKeyPair();
    const ask = (requestId: string, tenant: string, partition: string, ts = Date.now()) =>
      probe.dispatchRunRequest({
        requestId,
        tenant,
        body: {
          kind: MESSAGE_KEY_REQUEST,
          publicKey: pair.publicKey,
          partition,
          ts,
          nonce: `nonce-${requestId}-0123456789`,
        } as unknown as RunRequest['body'],
      });
    await ask('mk-wrong-token', 'tok-nobody', 'acme');
    await ask('mk-other-partition', 'tok-acme', 'globex');
    await ask('mk-stale', 'tok-acme', 'acme', Date.now() - 5 * 60_000);
    await ask('mk-good', 'tok-acme', 'acme');
    await probe.dispatchRunRequest({
      requestId: 'mk-bad-key',
      tenant: 'tok-acme',
      body: {
        kind: MESSAGE_KEY_REQUEST,
        publicKey: 'not-a-key',
        partition: 'acme',
        ts: Date.now(),
      } as unknown as RunRequest['body'],
    });
    await until(() => replies.length >= 5);
    const by = (id: string) =>
      replies.find((r) => r.requestId === id)?.result as { ok: boolean; error?: { code?: string } };
    expect(by('mk-bad-key')).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    expect(by('mk-wrong-token')).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(by('mk-other-partition')).toMatchObject({ ok: false, error: { code: 'cross-tenant' } });
    expect(by('mk-stale')).toMatchObject({ ok: false });
    expect(by('mk-good')).toMatchObject({ ok: true });
    // Whoever captured the good grant (it is plain on the broker) cannot open it without the pod's key.
    const good = replies.find((r) => r.requestId === 'mk-good')?.result as unknown as {
      data: never;
    };
    const grant = good.data;
    expect(openGrant(grant, handshakeKeyPair(), 'mk-good', 'acme')).toBeNull();
    expect(openGrant(grant, pair, 'mk-good', 'acme')).not.toBeNull();
  });

  it('a tenant without a valid token never sends plain: its sealed send fails', async () => {
    const prefix = `dmsg-cpk-${randomUUID().slice(0, 8)}`;
    const cp = await controlPlaneSealer('app key');
    const cpT = await transport(prefix, cp.sealer);
    new RunRequestResponder(cpT, {} as never, {
      verifyTenant: async () => null,
    }).start();
    const pod = await tenantSealer('acme', ACME_KEY, 'tok-forged');
    const podT = await transport(prefix, pod.sealer, 'acme');
    void podT;
    await expect(
      pod.sealer.seal('result', { runId: 'r', seq: 0, stepId: 'r:0', status: 'completed' }),
    ).rejects.toThrow(/refused this pod's message key/);
  });

  it('a control plane that rotates its crypto key: pods ask again, in-flight messages still open', async () => {
    const prefix = `dmsg-cpk-${randomUUID().slice(0, 8)}`;
    const server = new FakeCryptoServer();
    const cp = await controlPlaneSealer('crypto embedded', server);
    const cpT = await transport(prefix, cp.sealer);
    new RunRequestResponder(cpT, {} as never, {
      verifyTenant: async ({ token }) => verified(token, []),
    }).start();
    const acme = await tenantSealer('acme', ACME_KEY, 'tok-acme');
    const acmeT = await transport(prefix, acme.sealer, 'acme');
    void acmeT;
    const before = wire(
      await acme.sealer.seal('result', {
        runId: 'r',
        seq: 0,
        stepId: 'r:0',
        status: 'completed',
        output: 'x',
      }),
    );
    const kidOf = (m: unknown) => String((m as { sealed: string }).sealed).split('.')[3];
    expect(await cp.sealer.open('result', before)).toMatchObject({ output: 'x' });

    server.rotate('hub', 'durable-message-keys');
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 60_000);
    try {
      const task = {
        runId: 'r',
        seq: 1,
        stepId: 'r:1',
        name: 'pay',
        group: 'pay@acme',
        input: 'after',
        attempt: 1,
      };
      const rotated = wire(await cp.sealer.seal('task', task));
      expect(kidOf(rotated)).not.toBe(kidOf(before));
      // The pod does not hold the new kid: it asks again, then opens.
      expect(await acme.sealer.open('task', rotated)).toEqual(task);
      // A message sealed under the previous kid still opens at the control plane.
      expect(await cp.sealer.open('result', before)).toMatchObject({ output: 'x' });
    } finally {
      spy.mockRestore();
    }
    void quiet;
  });

  it('a message of one tenant does not open as another tenant', async () => {
    const prefix = `dmsg-cpk-${randomUUID().slice(0, 8)}`;
    const cp = await controlPlaneSealer('app key');
    const cpT = await transport(prefix, cp.sealer);
    new RunRequestResponder(cpT, {} as never, {
      verifyTenant: async ({ token }) => verified(token, []),
    }).start();
    const acme = await tenantSealer('acme', ACME_KEY, 'tok-acme');
    const globex = await tenantSealer('globex', GLOBEX_KEY, 'tok-globex');
    await transport(prefix, acme.sealer, 'acme');
    await transport(prefix, globex.sealer, 'globex');
    const task = {
      runId: 'r',
      seq: 0,
      stepId: 'r:0',
      name: 'pay',
      group: 'pay@acme',
      input: { card: 'acme-only' },
      attempt: 1,
    };
    const sealed = wire(await cp.sealer.seal('task', task));
    expect(await acme.sealer.open('task', sealed)).toEqual(task);
    await expect(globex.sealer.open('task', sealed)).rejects.toMatchObject({
      reason: 'unauthenticated',
    });
  });
});

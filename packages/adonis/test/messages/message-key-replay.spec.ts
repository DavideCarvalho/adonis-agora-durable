import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunReply, RunRequest } from '../../src/interfaces.js';
import { resolveMessageSealer } from '../../src/messages/resolve.js';
import { createMessageSealer, type MessageSealer } from '../../src/messages/sealer.js';
import {
  handshakeKeyPair,
  MESSAGE_KEY_PATH,
  MESSAGE_KEY_REQUEST,
  MessageKeyGuard,
  memoryClaimOnce,
  tokenIdentity,
  usableKeyUrl,
} from '../../src/messages/tenant-keys.js';
import { messageKeyRoute } from '../../src/run-gateway/message-key-route.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { makeTransportDb } from '../../src/transports/db-helpers.js';
import { lucidWorkerKeys } from '../../src/transports/worker-keys-db.js';
import { backendUrl } from '../support/backends.js';

/**
 * 1.3.1: a `messageKey` request is single-use (nonce + timestamp; one key request per token while it
 * lives, remembered in a store every control-plane replica shares), and a pod with the control
 * plane's URL asks over HTTPS, so its token never crosses the broker for it.
 */

const REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const CP_KEY = 'control-plane-app-key-0123456789abcd';
const ACME_KEY = 'acme-app-key-0123456789abcdefghijk';

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const body = (overrides: Record<string, unknown> = {}) => ({
  kind: MESSAGE_KEY_REQUEST,
  publicKey: handshakeKeyPair().publicKey,
  partition: 'acme',
  ts: Date.now(),
  nonce: randomUUID().replaceAll('-', ''),
  ...overrides,
});

describe('the single-use guard', () => {
  it('identifies a JWT by its jti and holds it for its remaining lifetime, else hashes the token', () => {
    const now = Date.now();
    expect(
      tokenIdentity(jwt({ jti: 'abc', exp: Math.floor(now / 1000) + 600 }), now),
    ).toMatchObject({
      id: 'jti:abc',
    });
    expect(
      tokenIdentity(jwt({ jti: 'abc', exp: Math.floor(now / 1000) + 600 }), now).holdMs,
    ).toBeGreaterThan(590_000);
    const opaque = tokenIdentity('an-opaque-token');
    expect(opaque.id).toMatch(/^h:/);
    expect(opaque.holdMs).toBe(60_000);
  });

  it('refuses an exact replay and a second request with the same token, warning once per partition', async () => {
    const warn = vi.fn();
    const guard = new MessageKeyGuard(memoryClaimOnce(), warn);
    const first = body() as never;
    expect(await guard.check('tok', first)).toBeNull();
    expect(await guard.check('tok', first)).toMatchObject({
      code: 'replayed',
      message: expect.stringMatching(/replayed/),
    });
    expect(await guard.check('tok', body() as never)).toMatchObject({
      code: 'replayed',
      message: expect.stringMatching(/already asked/),
    });
    expect(await guard.check('other-token', body() as never)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/possibly a replay/);
    // A store that cannot remember: refused (fail closed), never let through.
    const broken = new MessageKeyGuard(async () => {
      throw new Error('redis down');
    }, warn);
    expect(await broken.check('tok', body() as never)).toMatchObject({ code: 'unavailable' });
  });

  it('a URL is used for the key only when it is HTTPS (or plain HTTP to this machine)', () => {
    expect(usableKeyUrl('https://hub.example.com')).toBe(true);
    expect(usableKeyUrl('http://127.0.0.1:3333')).toBe(true);
    expect(usableKeyUrl('http://hub.example.com')).toBe(false);
    expect(usableKeyUrl('not a url')).toBe(false);
  });

  it('on the database: one claim wins across processes sharing it', async () => {
    const db = await makeTransportDb();
    try {
      const a = lucidWorkerKeys(db);
      const b = lucidWorkerKeys(db);
      const results = await Promise.all([a.claim?.('k', 60_000), b.claim?.('k', 60_000)]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await a.claim?.('expired', 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(await b.claim?.('expired', 60_000)).toBe(true);
    } finally {
      await db.manager.closeAll();
    }
  });
});

describe('the control plane’s HTTPS route', () => {
  const ctx = (headers: Record<string, string>, payload: unknown) => {
    const sent: { status?: number; body?: unknown } = {};
    return {
      sent,
      ctx: {
        request: { header: (n: string) => headers[n], body: () => payload },
        response: {
          status: (code: number) => {
            sent.status = code;
            return {
              json: (b: unknown) => {
                sent.body = b;
                return b;
              },
            };
          },
        },
      },
    };
  };

  it('passes the bearer token and the request on, and maps refusals to statuses', async () => {
    const calls: unknown[] = [];
    const answers = [
      { ok: true, data: { kid: 'k' } },
      { ok: false, error: { message: 'x', code: 'replayed' } },
      { ok: false, error: { message: 'x', code: 'unauthorized' } },
    ];
    const route = messageKeyRoute(async () => ({
      grantMessageKey: async (token: string, body: unknown, requestId: string) => {
        calls.push({ token, body, requestId });
        return answers.shift() as never;
      },
    }));
    const one = ctx({ authorization: 'Bearer tok-acme#1' }, { requestId: 'mk-1', nonce: 'n' });
    await route(one.ctx);
    expect(one.sent.status).toBe(200);
    expect(calls[0]).toEqual({ token: 'tok-acme#1', body: { nonce: 'n' }, requestId: 'mk-1' });
    const two = ctx({ authorization: 'Bearer t' }, { requestId: 'mk-2' });
    await route(two.ctx);
    expect(two.sent.status).toBe(409);
    const three = ctx({}, { requestId: 'mk-3' });
    await route(three.ctx);
    expect(three.sent.status).toBe(403);
    const none = ctx({}, {});
    await messageKeyRoute(async () => null)(none.ctx);
    expect(none.sent.status).toBe(404);
  });
});

describe.skipIf(!REDIS_URL)('message-key requests over BullMQ and HTTPS', () => {
  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c().catch(() => undefined);
  });

  const verifyTenant = async ({ token }: { token?: string | undefined }) =>
    token?.startsWith('tok-acme') ? { partition: 'acme', capabilities: [] } : null;

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

  async function controlPlane(prefix: string) {
    const sealer = await resolveMessageSealer(
      {
        app: {
          config: {
            get: (k: string) =>
              k === 'durable'
                ? { topology: 'control-plane', messages: { seal: true } }
                : k === 'app.appKey'
                  ? CP_KEY
                  : undefined,
          },
        } as never,
        name: 'bullmq',
        log: () => undefined,
      },
      {},
    );
    const t = await transport(prefix, sealer);
    const responder = new RunRequestResponder(t, {} as never, { verifyTenant });
    responder.start();
    return { t, sealer, responder };
  }

  async function tenant(
    prefix: string,
    options: { url?: string; tokens?: () => string; reset?: () => void } = {},
  ) {
    const lines: string[] = [];
    let n = 1;
    const sealer = await resolveMessageSealer(
      {
        app: {
          config: {
            get: (k: string) =>
              k === 'durable'
                ? { topology: 'tenant', messages: { seal: true } }
                : k === 'app.appKey'
                  ? ACME_KEY
                  : undefined,
          },
        } as never,
        name: 'bullmq',
        log: (level, line) => lines.push(`${level}: ${line}`),
        tenant: {
          partition: 'acme',
          token: async () => options.tokens?.() ?? `tok-acme#${n}`,
          resetToken:
            options.reset ??
            (() => {
              n += 1;
            }),
          ...(options.url ? { url: async () => options.url, urlHint: options.url } : {}),
        },
      },
      {},
    );
    const t = await transport(prefix, sealer, 'acme');
    return { t, sealer, lines };
  }

  const until = async (cond: () => boolean, budgetMs = 15_000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > budgetMs) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('a captured request replayed, even at another replica, is refused', async () => {
    const prefix = `dmsg-mkr-${randomUUID().slice(0, 8)}`;
    const one = await controlPlane(prefix);
    const two = await controlPlane(prefix);
    const request = body();
    const at = (cp: typeof one) =>
      cp.responder.grantMessageKey('tok-acme#9', request, 'mk-captured');
    expect(await at(one)).toMatchObject({ ok: true });
    expect(await at(two)).toMatchObject({ ok: false, error: { code: 'replayed' } });
    // A new request with the stolen token, at either replica: refused too.
    expect(await two.responder.grantMessageKey('tok-acme#9', body(), 'mk-attacker')).toMatchObject({
      ok: false,
      error: { code: 'replayed' },
    });
  });

  it('a pod whose token was used first (a replay won the race) asks again with a fresh token', async () => {
    const prefix = `dmsg-mkr-${randomUUID().slice(0, 8)}`;
    const cp = await controlPlane(prefix);
    // The attacker spends the pod's next token first.
    expect(await cp.responder.grantMessageKey('tok-acme#1', body(), 'mk-attacker')).toMatchObject({
      ok: true,
    });
    const pod = await tenant(prefix);
    const task = {
      runId: 'r',
      seq: 0,
      stepId: 'r:0',
      name: 'pay',
      group: 'pay@acme',
      input: 7,
      attempt: 1,
    };
    // The pod's first request (tok-acme#1) is refused as a replay; it resets and asks with #2.
    const sealed = await pod.sealer.seal('result', {
      runId: 'r',
      seq: 0,
      stepId: 'r:0',
      status: 'completed',
      output: 1,
    });
    expect(await cp.sealer.open('result', JSON.parse(JSON.stringify(sealed)))).toMatchObject({
      output: 1,
    });
    void task;
  });

  it('over HTTPS: the pod gets its key, and sends nothing over the broker for it', async () => {
    const prefix = `dmsg-mkr-${randomUUID().slice(0, 8)}`;
    const cp = await controlPlane(prefix);
    const server: Server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== MESSAGE_KEY_PATH) {
        res.writeHead(404).end();
        return;
      }
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', async () => {
        const { requestId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const result = await cp.responder.grantMessageKey(token, rest, String(requestId));
        res.writeHead(result.ok ? 200 : 403, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => server.close(() => r(undefined))));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pod = await tenant(prefix, { url });
    // Whatever the pod sends over the broker for its key goes through here.
    const overBroker = vi.spyOn(pod.t, 'dispatchRunRequest');
    expect(pod.lines.join('\n')).toMatch(/asked over HTTPS/);
    const sealed = await pod.sealer.seal('result', {
      runId: 'r',
      seq: 0,
      stepId: 'r:0',
      status: 'completed',
      output: 'x',
    });
    expect(await cp.sealer.open('result', JSON.parse(JSON.stringify(sealed)))).toMatchObject({
      output: 'x',
    });
    expect(overBroker).not.toHaveBeenCalled();
  });

  it('without a reachable HTTPS route, falls back to the broker (and says so)', async () => {
    const prefix = `dmsg-mkr-${randomUUID().slice(0, 8)}`;
    const cp = await controlPlane(prefix);
    void cp;
    const server: Server = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => server.close(() => r(undefined))));
    const pod = await tenant(prefix, {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const overBroker = vi.spyOn(pod.t, 'dispatchRunRequest');
    const sealed = await pod.sealer.seal('result', {
      runId: 'r',
      seq: 0,
      stepId: 'r:0',
      status: 'completed',
      output: 'y',
    });
    expect(await cp.sealer.open('result', JSON.parse(JSON.stringify(sealed)))).toMatchObject({
      output: 'y',
    });
    expect(pod.lines.join('\n')).toMatch(
      /over HTTPS failed: .* has no \/__durable\/message-key.*over the broker instead/,
    );
    expect(overBroker).toHaveBeenCalledTimes(1);
    expect(overBroker.mock.calls[0]?.[0]).toMatchObject({ tenant: 'tok-acme#1' });
  });

  it('a plain http URL that is not local is never used', async () => {
    const prefix = `dmsg-mkr-${randomUUID().slice(0, 8)}`;
    await controlPlane(prefix);
    const pod = await tenant(prefix, { url: 'http://control-plane.example.com' });
    expect(pod.lines.join('\n')).toMatch(
      /asked over the broker \(the control plane's URL http:\/\/control-plane.example.com is not HTTPS\)/,
    );
    await pod.sealer.seal('result', { runId: 'r', seq: 0, stepId: 'r:0', status: 'completed' });
    expect(pod.lines.join('\n')).toMatch(/is not HTTPS/);
  });

  void createMessageSealer;
  void (null as unknown as RunReply | RunRequest | null);
});

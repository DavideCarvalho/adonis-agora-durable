import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunReply } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * The bullmq subscriber watchdog against a REAL Redis. Gated on `DURABLE_REDIS_URL` (or `REDIS_URL`)
 * and skipped without it:
 *
 *   DURABLE_REDIS_URL=redis://127.0.0.1:6379 npx vitest run bullmq-subscriber-heal
 *
 * Two failure shapes:
 * - a SILENT drop (VPN/NAT/idle timeout): the server forgets the subscription while the client
 *   socket stays open and unresponsive. Only the watchdog's PING can notice; without it the
 *   subscriber stays deaf forever. Reproduced with a TCP relay that severs only its upstream leg.
 * - a LOUD drop (`CLIENT KILL`): a real FIN/RST. ioredis reconnects and resubscribes on its own; the
 *   test pins that the transport keeps delivering afterwards and that the burst of connection
 *   errors is handled.
 */
const REDIS_URL = process.env.DURABLE_REDIS_URL ?? backendUrl('REDIS_URL');

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c().catch(() => {});
});

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition was never met');
}

interface AdminClient {
  pubsub(sub: 'NUMSUB', channel: string): Promise<unknown[]>;
  client(...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

async function adminClient(url: string): Promise<AdminClient> {
  const specifier = 'ioredis';
  const { Redis } = (await import(specifier)) as { Redis: new (url: string) => AdminClient };
  return new Redis(url);
}

async function numsub(admin: AdminClient, channel: string): Promise<number> {
  const reply = await admin.pubsub('NUMSUB', channel);
  return typeof reply[1] === 'number' ? reply[1] : Number(reply[1] ?? 0);
}

/**
 * A TCP relay whose `freeze()` turns its open connections silent: the upstream (relay → Redis) leg is
 * destroyed, so the server drops the subscription, while the downstream (client → relay) socket stays
 * open and never answers. From ioredis's side the status stays `ready` and nothing errors. A
 * connection made after `freeze()` (the reconnect the watchdog triggers) relays normally.
 */
function startSilentProxy(
  targetHost: string,
  targetPort: number,
): Promise<{ port: number; freeze: () => void; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const pairs: Array<{ down: net.Socket; up: net.Socket; frozen: boolean }> = [];
    const server = net.createServer((down) => {
      const up = net.connect(targetPort, targetHost);
      const pair = { down, up, frozen: false };
      pairs.push(pair);
      down.on('data', (chunk) => {
        if (!pair.frozen) up.write(chunk);
      });
      up.on('data', (chunk) => {
        if (!pair.frozen) down.write(chunk);
      });
      down.on('error', () => {});
      up.on('error', () => {});
      down.on('close', () => {
        if (!pair.frozen) up.destroy();
      });
      up.on('close', () => {
        if (!pair.frozen) down.destroy();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('silent proxy failed to bind'));
        return;
      }
      resolve({
        port: address.port,
        freeze: () => {
          for (const pair of pairs) {
            if (pair.frozen) continue;
            pair.frozen = true;
            pair.up.destroy();
          }
        },
        close: () =>
          new Promise((res) => {
            for (const pair of pairs) {
              pair.down.destroy();
              pair.up.destroy();
            }
            server.close(() => res());
          }),
      });
    });
  });
}

describe.skipIf(!REDIS_URL)('BullMQTransport subscriber heal (real Redis)', () => {
  const url = new URL(REDIS_URL ?? 'redis://127.0.0.1:6379');

  it('heals a silently-dropped run-reply subscriber and keeps delivering replies', async () => {
    const prefix = uniqueRedisPrefix('durable-heal');
    const channel = `${prefix}-run-reply`;
    const proxy = await startSilentProxy(url.hostname, Number(url.port || 6379));
    const admin = await adminClient(url.toString());
    closers.push(
      () => proxy.close(),
      async () => {
        await admin.quit();
      },
    );

    const controlPlane = new BullMQTransport({
      deps: await createBullMQDeps(url.toString()),
      prefix,
      pingIntervalMs: false,
    });
    // The tenant's subscriber goes through the relay; everything else talks to Redis directly.
    const tenant = new BullMQTransport({
      deps: await createBullMQDeps(`redis://127.0.0.1:${proxy.port}`),
      prefix,
      pingIntervalMs: 200,
    });
    closers.push(
      () => controlPlane.close(),
      () => tenant.close(),
    );

    const seen: RunReply[] = [];
    tenant.onRunReply((reply) => seen.push(reply));
    await waitUntil(async () => (await numsub(admin, channel)) === 1);

    proxy.freeze();
    await waitUntil(async () => (await numsub(admin, channel)) === 0);

    // The next PING hangs against the frozen socket, times out and reconnects.
    await waitUntil(async () => (await numsub(admin, channel)) === 1, 5_000);

    await controlPlane.publishRunReply({ requestId: 'heal-1', result: { ok: true, data: null } });
    await waitUntil(() => seen.some((r) => r.requestId === 'heal-1'), 5_000);
    expect(seen.map((r) => r.requestId)).toContain('heal-1');
  }, 30_000);

  it('resubscribes the heartbeat and tenant-event subscribers after CLIENT KILL', async () => {
    const prefix = uniqueRedisPrefix('durable-kill');
    const admin = await adminClient(url.toString());
    closers.push(async () => {
      await admin.quit();
    });
    const errors: unknown[] = [];
    const publisher = new BullMQTransport({
      deps: await createBullMQDeps(url.toString()),
      prefix,
      pingIntervalMs: false,
    });
    const subscriber = new BullMQTransport({
      deps: await createBullMQDeps(url.toString()),
      prefix,
      pingIntervalMs: 200,
      onError: (err) => errors.push(err),
    });
    closers.push(
      () => publisher.close(),
      () => subscriber.close(),
    );

    const beats: string[] = [];
    const events: string[] = [];
    subscriber.onHeartbeat(async (beat) => {
      beats.push(beat.stepId ?? beat.runId);
    });
    subscriber.onTenantEvent('acme', (evt) => events.push(evt.event.runId));
    await waitUntil(
      async () =>
        (await numsub(admin, `${prefix}-heartbeat`)) === 1 &&
        (await numsub(admin, `${prefix}-tenant-events-acme`)) === 1,
    );

    // Kill every pub/sub connection on the server: a real close, as a Redis failover or restart sends.
    await admin.client('KILL', 'TYPE', 'pubsub');
    await waitUntil(
      async () =>
        (await numsub(admin, `${prefix}-heartbeat`)) === 1 &&
        (await numsub(admin, `${prefix}-tenant-events-acme`)) === 1,
      5_000,
    );

    await publisher.heartbeat({ runId: 'r', seq: 0, stepId: 'r:0', group: 'g', at: Date.now() });
    await publisher.publishTenantEvent({
      tenant: 'acme',
      event: { type: 'run.started', runId: 'run-after-kill', at: new Date() },
    });
    await waitUntil(() => beats.includes('r:0') && events.includes('run-after-kill'), 5_000);
    expect(beats).toContain('r:0');
    expect(events).toContain('run-after-kill');
  }, 30_000);
});

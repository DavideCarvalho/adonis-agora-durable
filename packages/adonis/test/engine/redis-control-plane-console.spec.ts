import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import type { ConsoleCommand } from '../../src/interfaces.js';
import { backendUrl, uniqueRedisPrefix } from '../support/backends.js';

/**
 * Console commands over a REAL Redis (the federated console): the console's process sends, the
 * owning app's instances listen, and exactly one of them runs each command. The connections carry
 * different `keyPrefix`es, as two apps sharing one Redis do: channels are not keys, so they still
 * meet, and the claim key lives under the owning app's prefix.
 */
const REDIS_URL = backendUrl('REDIS_URL');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!REDIS_URL)('RedisControlPlane console commands (real Redis)', () => {
  const clients: Redis[] = [];
  const planes: RedisControlPlane[] = [];

  afterEach(async () => {
    for (const p of planes) await p.close();
    planes.length = 0;
    for (const c of clients) c.disconnect();
    clients.length = 0;
  });

  function client(keyPrefix?: string) {
    const c = new Redis(REDIS_URL as string, keyPrefix ? { keyPrefix } : {});
    clients.push(c);
    return c;
  }

  function plane(prefix: string, keyPrefix?: string) {
    const p = new RedisControlPlane({ connection: client(keyPrefix), prefix, pingIntervalMs: 0 });
    planes.push(p);
    return p;
  }

  async function listening(channel: string, count: number) {
    const c = client();
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [, n] = (await c.pubsub('NUMSUB', channel)) as [string, number];
      if (Number(n) >= count) return;
      if (Date.now() > deadline) throw new Error(`${channel} never reached ${count} subscribers`);
      await delay(10);
    }
  }

  it('runs each command on exactly one instance and answers the sender', async () => {
    const prefix = uniqueRedisPrefix('console');
    const ran: string[] = [];
    for (const name of ['web', 'worker-1', 'worker-2']) {
      plane(prefix, 'owner:').onConsoleCommand(async (command: ConsoleCommand) => {
        ran.push(`${name}:${command.verb}`);
        return { runId: command.args[0], at: new Date('2026-11-17T12:00:00.000Z') };
      });
    }
    await listening(`${prefix}-console`, 3);
    const hub = plane(prefix, 'hub:');

    for (let i = 0; i < 5; i += 1) {
      const reply = await hub.sendConsoleCommand({
        id: `cmd-${i}`,
        verb: 'cancel',
        args: [`run-${i}`],
      });
      expect(reply).toEqual({
        id: `cmd-${i}`,
        ok: true,
        data: { runId: `run-${i}`, at: new Date('2026-11-17T12:00:00.000Z') },
      });
    }
    // Give a slow loser the chance to (wrongly) run a command too.
    await delay(100);
    expect(ran).toHaveLength(5);
    const owner = client();
    expect(await owner.exists(`owner:${prefix}-console-claim:cmd-0`)).toBe(1);
  });

  it('carries the owning app’s error back', async () => {
    const prefix = uniqueRedisPrefix('console');
    plane(prefix).onConsoleCommand(async () => {
      throw Object.assign(new Error('nope'), { code: 'unsupported-request' });
    });
    await listening(`${prefix}-console`, 1);
    const reply = await plane(prefix).sendConsoleCommand({ id: 'e1', verb: 'start', args: [] });
    expect(reply).toEqual({
      id: 'e1',
      ok: false,
      error: { message: 'nope', code: 'unsupported-request' },
    });
  });

  it('rejects at once when no instance of the app listens', async () => {
    const prefix = uniqueRedisPrefix('console');
    const started = Date.now();
    await expect(
      plane(prefix).sendConsoleCommand({ id: 'n1', verb: 'cancel', args: ['x'] }),
    ).rejects.toThrow(/listens for console commands/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('times out when the app never answers', async () => {
    const prefix = uniqueRedisPrefix('console');
    plane(prefix).onConsoleCommand(() => new Promise(() => {}));
    await listening(`${prefix}-console`, 1);
    await expect(
      plane(prefix).sendConsoleCommand(
        { id: 't1', verb: 'cancel', args: ['x'] },
        { timeoutMs: 200 },
      ),
    ).rejects.toThrow(/answered the console command cancel within 200ms/);
  });

  it('keeps the control channel working next to the console channels', async () => {
    const prefix = uniqueRedisPrefix('console');
    const a = plane(prefix);
    const received: string[] = [];
    a.onControl((msg) => {
      if (msg.kind === 'cancel') received.push(msg.runId);
    });
    a.onConsoleCommand(async () => 'pong');
    await listening(`${prefix}-control`, 1);
    await listening(`${prefix}-console`, 1);
    const b = plane(prefix);
    await b.publishControl({ kind: 'cancel', runId: 'r1', from: 'b' });
    expect((await b.sendConsoleCommand({ id: 'p', verb: 'workerHealth', args: [] })).ok).toBe(true);
    const deadline = Date.now() + 5_000;
    while (received.length === 0 && Date.now() < deadline) await delay(10);
    expect(received).toEqual(['r1']);
  });
});

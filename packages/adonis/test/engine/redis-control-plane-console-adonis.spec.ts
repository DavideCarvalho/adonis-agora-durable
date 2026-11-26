import { RedisConnection } from '@adonisjs/redis';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import type { ConsoleCommand } from '../../src/interfaces.js';
import { backendUrl, uniqueRedisPrefix } from '../support/backends.js';

/** The console commands are authenticated: the same secret on the console and the app. */
const auth = { secret: 'console-secret-0123456789' };

/**
 * The documented setup — `controlPlanes.redis({ connection: 'main' })` — hands the control plane an
 * `@adonisjs/redis` connection, not a raw ioredis client. Exactly one of the app's instances must
 * still run each console command: the claim has to work on that connection too.
 */
const REDIS_URL = backendUrl('REDIS_URL');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!REDIS_URL)('RedisControlPlane console commands on @adonisjs/redis', () => {
  const connections: RedisConnection[] = [];
  const planes: RedisControlPlane[] = [];
  const raw: Redis[] = [];

  afterEach(async () => {
    for (const p of planes) await p.close();
    planes.length = 0;
    for (const c of connections) await c.quit().catch(() => undefined);
    connections.length = 0;
    for (const c of raw) c.disconnect();
    raw.length = 0;
  });

  function connection(name: string) {
    const url = new URL(REDIS_URL as string);
    const c = new RedisConnection(name, {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    });
    connections.push(c);
    return c;
  }

  function plane(prefix: string, name: string) {
    const p = new RedisControlPlane({ connection: connection(name), prefix, pingIntervalMs: 0 });
    planes.push(p);
    return p;
  }

  async function listening(channel: string, count: number) {
    const c = new Redis(REDIS_URL as string);
    raw.push(c);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [, n] = (await c.pubsub('NUMSUB', channel)) as [string, number];
      if (Number(n) >= count) return;
      if (Date.now() > deadline) throw new Error(`${channel} never reached ${count} subscribers`);
      await delay(10);
    }
  }

  it('runs each command once across three listening instances', async () => {
    const prefix = uniqueRedisPrefix('console-adonis');
    const ran: string[] = [];
    for (const name of ['web', 'worker-1', 'worker-2']) {
      plane(prefix, name).onConsoleCommand(
        async (command: ConsoleCommand) => {
          ran.push(`${name}:${command.verb}:${command.args[0]}`);
          return { cancelled: command.args[0] };
        },
        { auth },
      );
    }
    await listening(`${prefix}-console`, 3);
    const hub = plane(prefix, 'hub');
    for (let i = 0; i < 5; i += 1) {
      const reply = await hub.sendConsoleCommand(
        { id: `a-${i}`, verb: 'cancel', args: [`r-${i}`] },
        { auth },
      );
      expect(reply).toEqual({ id: `a-${i}`, ok: true, data: { cancelled: `r-${i}` } });
    }
    await delay(150);
    expect(ran).toHaveLength(5);
    expect(new Set(ran.map((line) => line.split(':').slice(1).join(':'))).size).toBe(5);
  });

  it('refuses to answer when the connection cannot claim a command', async () => {
    const prefix = uniqueRedisPrefix('console-adonis');
    const c = connection('no-set');
    // A connection with pub/sub but no `SET` (and no ioredis client behind it).
    const noClaim = {
      publish: (channel: string, message: string) => c.publish(channel, message),
      subscribe: (channel: string, handler: (message: string) => void) =>
        c.subscribe(channel, handler),
    };
    const p = new RedisControlPlane({ connection: noClaim, prefix, pingIntervalMs: 0 });
    planes.push(p);
    expect(() => p.onConsoleCommand(async () => 'ran', { auth })).toThrow(/refusing to answer/);
    await expect(
      plane(prefix, 'hub').sendConsoleCommand({ id: 'x', verb: 'cancel', args: ['r'] }, { auth }),
    ).rejects.toThrow(/listens for console commands/);
  });

  it('close() gives back the subscriber connection @adonisjs/redis opened for it (an ace command exits)', async () => {
    const tcp = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap' || r === 'TCPWRAP')
        .length;
    const before = tcp();
    const conn = connection('release');
    const p = new RedisControlPlane({
      connection: conn,
      prefix: uniqueRedisPrefix('release'),
      pingIntervalMs: 0,
    });
    p.observeAll?.();
    p.onControl(() => undefined);
    await delay(100);
    const live = conn as unknown as { ioSubscriberConnection?: { status: string } };
    expect(live.ioSubscriberConnection?.status).toBe('ready');
    await p.close();
    await delay(100);
    // The subscriber is gone (closed, and dropped by @adonisjs/redis on its 'end').
    expect(
      live.ioSubscriberConnection === undefined || live.ioSubscriberConnection.status === 'end',
    ).toBe(true);
    await conn.quit();
    connections.splice(connections.indexOf(conn), 1);
    await delay(100);
    expect(tcp()).toBeLessThanOrEqual(before);
  });
});

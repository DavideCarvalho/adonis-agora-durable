import { afterEach, describe, expect, it } from 'vitest';
import {
  ConsoleCommandAuth,
  type ConsoleCommandAuthOptions,
  UNSIGNED_CHANNEL,
} from '../../src/control-plane-redis/console-auth.js';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import type { ConsoleCommand } from '../../src/interfaces.js';
import { RedisBus, settle } from '../support/redis-bus.js';

/**
 * The console-command path of the Redis control plane is authenticated (shared-secret mode here;
 * token and crypto mode in their own files). Someone who can publish on Redis must not be able to
 * run a command, claim any actor, replay one, or answer for the app.
 */
const SECRET = 'federation-secret-0123456789';
const auth: ConsoleCommandAuthOptions = { secret: SECRET };

describe('console commands on the Redis control plane are authenticated', () => {
  const planes: RedisControlPlane[] = [];
  afterEach(async () => {
    for (const p of planes.splice(0)) await p.close();
  });
  const plane = (bus: RedisBus, prefix = 'shop') => {
    const p = new RedisControlPlane({ connection: bus.connection(), prefix, pingIntervalMs: 0 });
    planes.push(p);
    return p;
  };

  it('neither sends nor answers without authentication', async () => {
    const bus = new RedisBus();
    const p = plane(bus);
    expect(() => p.onConsoleCommand(async () => null)).toThrow(/no authentication/);
    expect(() => p.onConsoleCommand(async () => null, { auth: {} })).toThrow(/no authentication/);
    await expect(
      p.sendConsoleCommand({ id: '1', verb: 'cancel', args: ['r'] }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: UNSIGNED_CHANNEL });
    // Nothing was published.
    expect(bus.published).toEqual([]);
  });

  it('refuses unsigned, forged, tampered, stale and replayed commands, and runs a signed one', async () => {
    const bus = new RedisBus();
    const ran: ConsoleCommand[] = [];
    const errors: unknown[] = [];
    plane(bus).onConsoleCommand(
      async (command) => {
        ran.push(command);
        return { cancelled: command.args[0] };
      },
      { auth, onError: (error) => errors.push(error) },
    );
    const raw = bus.connection();
    const forged = {
      id: 'forged-1',
      verb: 'cancel',
      args: ['run-1'],
      actor: 'alice',
      verified: { partition: 'shop', capabilities: ['*'] },
    };
    await raw.publish('shop-console', JSON.stringify(forged));
    await raw.publish(
      'shop-console',
      JSON.stringify({ ...forged, id: 'forged-2', ts: Date.now(), mac: 'AAAA' }),
    );
    await settle();
    expect(ran).toHaveLength(0);
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });

    const console = plane(bus);
    const reply = await console.sendConsoleCommand(
      { id: 'real-1', verb: 'cancel', args: ['run-2'], actor: 'bob' },
      { auth },
    );
    expect(reply).toEqual({ id: 'real-1', ok: true, data: { cancelled: 'run-2' } });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toEqual({ id: 'real-1', verb: 'cancel', args: ['run-2'], actor: 'bob' });

    // The same signed message published again (a replay) does not run twice.
    const signed = bus.published.find(
      (p) => p.channel === 'shop-console' && p.message.includes('"real-1"'),
    )!;
    await raw.publish('shop-console', signed.message);
    // A tampered copy (another run, another actor) fails the MAC.
    const wire = JSON.parse(signed.message) as Record<string, unknown>;
    await raw.publish('shop-console', JSON.stringify({ ...wire, id: 'real-2', args: ['run-9'] }));
    await raw.publish('shop-console', JSON.stringify({ ...wire, id: 'real-3', actor: 'mallory' }));
    // A stale one: signed over a minute ago (the MAC covers `ts`, so it cannot be refreshed).
    await raw.publish('shop-console', JSON.stringify({ ...wire, ts: Date.now() - 120_000 }));
    await settle();
    expect(ran).toHaveLength(1);
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it('drops a `verified` field put next to a valid signature', async () => {
    const bus = new RedisBus();
    const ran: ConsoleCommand[] = [];
    plane(bus).onConsoleCommand(
      async (command) => {
        ran.push(command);
        return null;
      },
      { auth },
    );
    // A real console's signed command, with a claimed token verification added on the way.
    const { wire } = await new ConsoleCommandAuth({ ...auth, prefix: 'shop' }).wrap({
      id: 'v-1',
      verb: 'cancel',
      args: ['run-1'],
    });
    await bus.connection().publish(
      'shop-console',
      JSON.stringify({
        ...(wire as object),
        verified: { partition: 'shop', capabilities: ['*'] },
      }),
    );
    await settle();
    expect(ran).toHaveLength(1);
    expect(ran[0]).not.toHaveProperty('verified');
  });

  it('ignores a forged answer and waits for the signed one', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // A rogue subscriber answers every command first.
    await raw.subscribe('shop-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish('shop-console-reply', JSON.stringify({ id, ok: true, data: 'forged' }));
    });
    plane(bus).onConsoleCommand(async () => 'real', { auth });
    const reply = await plane(bus).sendConsoleCommand(
      { id: 'k-1', verb: 'workerHealth', args: [] },
      { auth },
    );
    expect(reply).toEqual({ id: 'k-1', ok: true, data: 'real' });
  });

  it('refuses a command signed with another secret, or for another prefix', async () => {
    const bus = new RedisBus();
    const ran: ConsoleCommand[] = [];
    plane(bus).onConsoleCommand(
      async (command) => {
        ran.push(command);
        return null;
      },
      { auth },
    );
    await expect(
      plane(bus).sendConsoleCommand(
        { id: 'o-1', verb: 'cancel', args: ['r'] },
        { auth: { secret: 'another-secret-0123456789' }, timeoutMs: 100 },
      ),
    ).rejects.toThrow(/answered within 0.1s — the app may have refused the command/);
    // The same secret on another app's prefix: the MAC is bound to the prefix.
    const other = plane(bus, 'billing');
    await other
      .sendConsoleCommand({ id: 'o-2', verb: 'cancel', args: ['r'] }, { auth })
      .catch(() => undefined);
    const wire = bus.published.find((p) => p.channel === 'billing-console')?.message;
    if (wire) await bus.connection().publish('shop-console', wire);
    await settle();
    expect(ran).toEqual([]);
  });

  it('rejects a secret shorter than 16 characters', () => {
    const bus = new RedisBus();
    expect(() =>
      plane(bus).onConsoleCommand(async () => null, { auth: { secret: 'short' } }),
    ).toThrow(/at least 16 characters/);
  });
});

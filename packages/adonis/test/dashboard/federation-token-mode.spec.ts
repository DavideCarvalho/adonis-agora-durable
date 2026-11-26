import { afterEach, describe, expect, it } from 'vitest';
import {
  consoleCommandPublicKey,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/control-plane-redis/console-auth.js';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import {
  type AnswerConsoleCommandsOptions,
  answerConsoleCommands,
  FEDERATED_FORBIDDEN,
  FederatedApp,
} from '../../src/dashboard/federation.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { ConsoleCommand, TenantVerifier } from '../../src/index.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { RedisBus, settle } from '../support/redis-bus.js';

const PREFIX = 'shop';
const APP_KEY = 'app-key-of-the-shop-0123456789';

/** A stand-in for authkitTenantVerifier: one token per console client. */
const verifyTenant: TenantVerifier = ({ token }) => {
  if (token === 'hub-writer') return { partition: 'shop', capabilities: ['durable:*'] };
  if (token === 'hub-reader') return { partition: 'shop', capabilities: ['durable:read'] };
  if (token === 'hub-runs') return { partition: 'shop', capabilities: ['durable:runs:write'] };
  if (token === 'hub-other-app') return { partition: 'billing', capabilities: ['durable:*'] };
  if (token === 'acme') return { partition: 'acme', capabilities: ['durable:*'] };
  if (token === 'globex') return { partition: 'globex', capabilities: ['durable:*'] };
  if (token === 'cp') return { partition: 'cp', capabilities: ['durable:*'] };
  return null;
};

const planes: RedisControlPlane[] = [];
afterEach(async () => {
  for (const p of planes.splice(0)) await p.close();
});

function plane(bus: RedisBus) {
  const p = new RedisControlPlane({
    connection: bus.connection(),
    prefix: PREFIX,
    pingIntervalMs: 0,
  });
  planes.push(p);
  return p;
}

/** The owning app: its engine answers on the bus with `consoleCommands` like the provider sets it. */
function setup(options: Partial<AnswerConsoleCommandsOptions> = {}) {
  const bus = new RedisBus();
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, instanceId: 'shop' });
  engine.register('approval', '1', async (ctx) => ctx.waitForSignal('approve'));
  const seen: ConsoleCommand[] = [];
  const errors: unknown[] = [];
  const owner = plane(bus);
  const answer = owner.onConsoleCommand.bind(owner);
  owner.onConsoleCommand = (handler, opts) =>
    answer((command) => {
      seen.push(command);
      return handler(command);
    }, opts);
  answerConsoleCommands(owner, storeDashboardEngine(engine), undefined, {
    auth: { verifyTenant, appKey: APP_KEY },
    partition: 'shop',
    actions: true,
    onError: (error) => errors.push(error),
    ...options,
  });
  const consoleWith = (token: string, onReset?: () => void) =>
    new FederatedApp({
      id: 'shop',
      store,
      controlPlane: plane(bus),
      timeoutMs: 1_000,
      auth: {
        token: Object.assign(async () => token, { reset: () => onReset?.() }),
        // Configured on the console from the app's `node ace durable:console-key`, not from Redis.
        publicKey: consoleCommandPublicKey(APP_KEY, PREFIX),
      },
    }).engine('alice@hub');
  return { bus, store, engine, seen, errors, consoleWith };
}

describe('federated console, token mode (authkit)', () => {
  it('runs a command whose token the app verifies, with the token never readable on Redis', async () => {
    const { bus, engine, seen, consoleWith } = setup();
    await engine.start('approval', {}, 'run-1');
    await settle();
    expect(await consoleWith('hub-writer').cancel('run-1')).not.toBeNull();
    expect((await engine.getRun('run-1'))?.status).toBe('cancelled');
    expect(seen[0]).toMatchObject({
      verb: 'cancel',
      actor: 'alice@hub',
      verified: { partition: 'shop', capabilities: ['durable:*'] },
    });
    // The command and its token cross Redis sealed: a reader learns neither. (The answer is
    // authenticated, not encrypted.)
    const commands = bus.published
      .filter((p) => p.channel === 'shop-console')
      .map((p) => p.message)
      .join('\n');
    expect(commands).toContain('durable:pk1:');
    expect(bus.wire).not.toContain('hub-writer');
    expect(commands).not.toContain('run-1');
    expect(commands).not.toContain('cancel');
    expect(commands).not.toContain('alice@hub');
  });

  it('refuses an unknown token (and the console drops its cached token)', async () => {
    const { engine, consoleWith } = setup();
    await engine.start('approval', {}, 'run-2');
    await settle();
    let resets = 0;
    await expect(
      consoleWith('stolen-or-made-up', () => {
        resets += 1;
      }).cancel('run-2'),
    ).rejects.toMatchObject({ code: UNAUTHORIZED_CONSOLE, status: 401 });
    expect(resets).toBe(1);
    expect((await engine.getRun('run-2'))?.status).toBe('suspended');
  });

  it('answers 403 to a token for another app', async () => {
    const { engine, consoleWith } = setup();
    await engine.start('approval', {}, 'run-3');
    await settle();
    await expect(consoleWith('hub-other-app').cancel('run-3')).rejects.toMatchObject({
      code: FEDERATED_FORBIDDEN,
      status: 403,
      message: expect.stringMatching(/token is for "billing"/),
    });
    expect((await engine.getRun('run-3'))?.status).toBe('suspended');
  });

  it('lets a read-only token read, but not cancel, signal, approve or trigger', async () => {
    const { engine, consoleWith } = setup();
    await engine.start('approval', {}, 'run-4');
    await settle();
    const reader = consoleWith('hub-reader');
    expect(Array.isArray(await reader.workerHealth())).toBe(true);
    await expect(reader.cancel('run-4')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/lacks durable:runs:write/),
    });
    await expect(reader.signal?.('approve', { ok: true })).rejects.toMatchObject({ status: 403 });
    await expect(reader.completeTask?.('run-4', 'review', {})).rejects.toMatchObject({
      message: expect.stringMatching(/lacks durable:tasks:write/),
    });
    await expect(reader.triggerSchedule?.('nightly')).rejects.toMatchObject({
      message: expect.stringMatching(/lacks durable:schedules:write/),
    });
    // A runs-only token may act on runs, not on tasks.
    await expect(consoleWith('hub-runs').failTask?.('run-4', 'review', 'no')).rejects.toMatchObject(
      {
        status: 403,
      },
    );
    expect((await engine.getRun('run-4'))?.status).toBe('suspended');
  });

  it('refuses unsealed, tampered and replayed commands', async () => {
    const { bus, engine, seen, errors, consoleWith } = setup();
    await engine.start('approval', {}, 'run-5');
    await engine.start('approval', {}, 'run-6');
    await settle();
    const raw = bus.connection();
    // Someone with Redis access publishes a plain command claiming a verified token.
    await raw.publish(
      'shop-console',
      JSON.stringify({
        id: crypto.randomUUID(),
        verb: 'cancel',
        args: ['run-5'],
        verified: { partition: 'shop', capabilities: ['*'] },
      }),
    );
    await settle();
    expect(seen).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });

    // A real command, then a copy under a new id, a bit-flipped copy and a straight replay.
    await consoleWith('hub-writer').workerHealth();
    const sent = bus.published.find(
      (p) => p.channel === 'shop-console' && p.message.includes('sealed'),
    )!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    await raw.publish(
      'shop-console',
      JSON.stringify({ id: crypto.randomUUID(), sealed: wire.sealed }),
    );
    await raw.publish('shop-console', JSON.stringify({ ...wire, sealed: flipped }));
    await raw.publish('shop-console', sent.message);
    await settle();
    expect(seen).toHaveLength(1);
    expect((await engine.getRun('run-5'))?.status).toBe('suspended');
  });

  it('ignores a forged answer and waits for the app', async () => {
    const { bus, consoleWith } = setup();
    const raw = bus.connection();
    await raw.subscribe('shop-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish('shop-console-reply', JSON.stringify({ id, ok: true, data: ['forged'] }));
    });
    const health = await consoleWith('hub-writer').workerHealth();
    expect(health).not.toEqual(['forged']);
  });

  it('the console refuses a token without the app’s public key, and a bad key', async () => {
    const bus = new RedisBus();
    const p = plane(bus);
    await expect(
      p.sendConsoleCommand({ id: '1', verb: 'cancel', args: [] }, { auth: { token: 't' } }),
    ).rejects.toThrow(/needs `crypto` or the app's `publicKey`/);
    await expect(
      p.sendConsoleCommand(
        { id: '2', verb: 'cancel', args: [] },
        { auth: { token: 't', publicKey: 'not-a-key' } },
      ),
    ).rejects.toThrow(/not a console-command key/);
  });

  it('a key derived from another APP_KEY or prefix does not open the command', async () => {
    const { bus, seen, errors } = setup();
    const wrong = new FederatedApp({
      id: 'shop',
      store: new InMemoryStateStore(),
      controlPlane: plane(bus),
      timeoutMs: 200,
      auth: {
        token: 'hub-writer',
        publicKey: consoleCommandPublicKey('another-app-key-0123456789', PREFIX),
      },
    });
    await expect(wrong.engine().workerHealth()).rejects.toThrow(/answered within 0.2s/);
    expect(consoleCommandPublicKey(APP_KEY, 'billing')).not.toBe(
      consoleCommandPublicKey(APP_KEY, PREFIX),
    );
    expect(seen).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });
  });
});

describe('federated console on a control plane: runs are confined to the allowed apps', () => {
  async function seeded(options: Partial<AnswerConsoleCommandsOptions>) {
    const ctx = setup({ confineRuns: true, ...options });
    await ctx.engine.start('approval', {}, 'acme-1', { namespace: 'acme' });
    await ctx.engine.start('approval', {}, 'globex-1', { namespace: 'globex' });
    await settle();
    return ctx;
  }

  it('a token acts on its own app’s runs only', async () => {
    const { engine, consoleWith } = await seeded({ apps: ['acme', 'globex'] });
    const acme = consoleWith('acme');
    // Another app's run reads as missing: the action answers not-found and changes nothing.
    expect(await acme.cancel('globex-1')).toBeNull();
    expect((await engine.getRun('globex-1'))?.status).not.toBe('cancelled');
    expect(await acme.cancel('acme-1')).not.toBeNull();
    expect((await engine.getRun('acme-1'))?.status).toBe('cancelled');
  });

  it('refuses a token for an app the control plane does not list', async () => {
    const { consoleWith } = await seeded({ apps: ['acme'] });
    await expect(consoleWith('globex').cancel('globex-1')).rejects.toMatchObject({ status: 403 });
  });

  it('without `apps`, a token for a tenant app is refused: acting across tenants takes an explicit list', async () => {
    const { engine, consoleWith } = await seeded({ apps: undefined, partition: 'cp' });
    await expect(consoleWith('acme').cancel('acme-1')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(
        /token is for "acme", not "cp" \(list it in `consoleCommands.apps`/,
      ),
    });
    expect((await engine.getRun('acme-1'))?.status).not.toBe('cancelled');
  });

  it('a token for the control plane itself acts on its own runs only, not the tenants’', async () => {
    const { engine, consoleWith } = await seeded({ apps: undefined, partition: 'cp' });
    await engine.start('approval', {}, 'cp-1');
    await settle();
    expect(await consoleWith('cp').cancel('acme-1')).toBeNull();
    expect((await engine.getRun('acme-1'))?.status).not.toBe('cancelled');
    expect(await consoleWith('cp').cancel('cp-1')).not.toBeNull();
  });

  it('a classic token for another app is refused on a standalone app (partition rule)', async () => {
    const { consoleWith } = setup({ partition: 'shop' });
    await expect(consoleWith('acme').workerHealth?.()).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/token is for "acme", not "shop"/),
    });
  });

  it('confines a shared-secret console to the listed apps', async () => {
    const bus = new RedisBus();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, instanceId: 'cp' });
    engine.register('approval', '1', async (ctx) => ctx.waitForSignal('approve'));
    await engine.start('approval', {}, 'acme-2', { namespace: 'acme' });
    await engine.start('approval', {}, 'globex-2', { namespace: 'globex' });
    await settle();
    const secret = 'shared-secret-0123456789';
    answerConsoleCommands(plane(bus), storeDashboardEngine(engine), undefined, {
      auth: { secret },
      apps: ['acme'],
      confineRuns: true,
      actions: true,
    });
    const console = new FederatedApp({
      id: 'cp',
      store,
      controlPlane: plane(bus),
      auth: { secret },
    }).engine();
    expect(await console.cancel('globex-2')).toBeNull();
    expect((await engine.getRun('globex-2'))?.status).not.toBe('cancelled');
    expect(await console.cancel('acme-2')).not.toBeNull();
  });
});

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleCipher } from '../../src/control-plane-redis/console-auth.js';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { appScopedDashboardEngine } from '../../src/dashboard/app_scope.js';
import {
  type AnswerConsoleCommandsOptions,
  answerConsoleCommands,
  consoleVerbAllowed,
  FederatedApp,
  viewerConsoleCapabilities,
  viewerScopedDashboardEngine,
} from '../../src/dashboard/federation.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { cancelRun, signalRun } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { RedisBus, settle } from '../support/redis-bus.js';

/**
 * Every console command carries the viewer's capabilities, and the app refuses one without them
 * (never "missing = everything"); actions also need the app's `actions` switch.
 */

const secret = 'shared-secret-0123456789';
const planes: RedisControlPlane[] = [];
afterEach(async () => {
  for (const p of planes.splice(0)) await p.close();
});

function plane(bus: RedisBus) {
  const p = new RedisControlPlane({
    connection: bus.connection(),
    prefix: 'shop',
    pingIntervalMs: 0,
  });
  planes.push(p);
  return p;
}

async function setup(options: Partial<AnswerConsoleCommandsOptions> = {}) {
  const bus = new RedisBus();
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, instanceId: 'shop' });
  engine.register('approval', '1', async (ctx) => ctx.waitForSignal('approve'));
  await engine.start('approval', {}, 'run-1');
  await settle();
  answerConsoleCommands(plane(bus), storeDashboardEngine(engine), undefined, {
    auth: { secret },
    actions: true,
    ...options,
  });
  const console = new FederatedApp({
    id: 'shop',
    store,
    controlPlane: plane(bus),
    auth: { secret },
  });
  return { bus, engine, console };
}

describe('console capabilities', () => {
  it('refuses a command without capabilities (403), whatever the mode', async () => {
    const { bus } = await setup();
    const reply = await plane(bus).sendConsoleCommand(
      { id: 'no-caps', verb: 'workerHealth', args: [] },
      { auth: { secret } },
    );
    expect(reply).toMatchObject({
      ok: false,
      error: {
        status: 403,
        code: 'capabilities-required',
        message: expect.stringMatching(
          /^\[@adonis-agora\/durable\] the console sent no capabilities/,
        ),
      },
    });
  });

  it('narrows to the viewer’s capabilities: reads with durable:read, no action without its write', async () => {
    const { engine, console } = await setup();
    const viewer = console.engine('ops', ['durable:read']);
    expect(Array.isArray(await viewer.workerHealth?.())).toBe(true);
    await expect(viewer.cancel('run-1')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/the viewer lacks durable:runs:write/),
    });
    expect((await engine.getRun('run-1'))?.status).not.toBe('cancelled');
    // Every verb needs its capability, reads included.
    await expect(
      console.engine('ops', ['durable:runs:write']).workerHealth?.(),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('`durable:console:*`, `durable:*` and `*` grant every verb; `durable:console:write` every action', async () => {
    for (const grant of ['durable:console:*', 'durable:*', '*']) {
      expect(consoleVerbAllowed([grant], 'cancel')).toBe(true);
      expect(consoleVerbAllowed([grant], 'listSchedules')).toBe(true);
    }
    expect(consoleVerbAllowed(['durable:console:write'], 'triggerSchedule')).toBe(true);
    // Write implies read (the canonical matcher).
    expect(consoleVerbAllowed(['durable:console:write'], 'listSchedules')).toBe(true);
    expect(consoleVerbAllowed(['durable:console:read'], 'getEvent')).toBe(true);
    expect(consoleVerbAllowed(['durable:console:read'], 'cancel')).toBe(false);
    const { engine, console } = await setup();
    await console.engine('ops', ['durable:console:*']).cancel('run-1');
    expect((await engine.getRun('run-1'))?.status).toBe('cancelled');
  });

  it('`actions` off (the default): reads answer, every action is 403 and says which line to add', async () => {
    const { engine, console } = await setup({ actions: undefined });
    expect(Array.isArray(await console.engine().workerHealth?.())).toBe(true);
    await expect(console.engine().cancel('run-1')).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/consoleCommands\.actions: true/),
    });
    expect((await engine.getRun('run-1'))?.status).not.toBe('cancelled');
  });

  it('a browse-only entry (`actions: false`) sends no action at all', async () => {
    const { bus } = await setup();
    const store = new InMemoryStateStore();
    const browse = new FederatedApp({
      id: 'shop',
      store,
      controlPlane: plane(bus),
      auth: { secret },
      actions: false,
    });
    const sent = bus.published.length;
    await expect(browse.engine().cancel('run-1')).rejects.toMatchObject({ status: 403 });
    expect(bus.published.length).toBe(sent);
    expect(Array.isArray(await browse.engine().workerHealth?.())).toBe(true);
  });
});

describe('crypto.owns: another KMS’s ciphertext format', () => {
  it('lets the app recognise a third-party cipher’s output', async () => {
    const bus = new RedisBus();
    const kms = new Map<string, string>();
    const cipher: ConsoleCipher = {
      encrypt: async ({ plaintext }) => {
        const id = `vault:v1:${randomBytes(8).toString('hex')}`;
        kms.set(id, plaintext);
        return { ciphertext: id };
      },
      decrypt: async ({ ciphertext }) => ({ plaintext: kms.get(ciphertext) ?? '' }),
    };
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, instanceId: 'shop' });
    const owns = (c: string) => c.startsWith('vault:v1:');
    answerConsoleCommands(plane(bus), storeDashboardEngine(engine), undefined, {
      auth: { crypto: { cipher, owns } },
    });
    const console = new FederatedApp({
      id: 'shop',
      store,
      controlPlane: plane(bus),
      auth: { crypto: { cipher, owns } },
    });
    expect(Array.isArray(await console.engine().workerHealth?.())).toBe(true);
  });
});

describe('republishLifecycle by workflow on an app-scoped console', () => {
  it('republishes the granted apps’ runs only', async () => {
    const raw = new WorkflowEngine({ store: new InMemoryStateStore(), instanceId: 'cp' });
    const seen: Array<string | undefined> = [];
    const base = storeDashboardEngine(raw);
    const spy = {
      ...base,
      republishLifecycle: async (
        target: Parameters<NonNullable<typeof base.republishLifecycle>>[0],
      ) => {
        seen.push('runId' in target ? target.runId : target.namespace);
        return { runs: 1, started: 0, failed: [] };
      },
    };
    const scoped = appScopedDashboardEngine(spy, ['acme']);
    expect(await scoped.republishLifecycle?.({ workflow: 'job' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
    expect(seen).toEqual(['acme']);
    // A namespace outside the grant republishes nothing.
    expect(await scoped.republishLifecycle?.({ workflow: 'job', namespace: 'globex' })).toEqual({
      runs: 0,
      started: 0,
      failed: [],
    });
    expect(seen).toEqual(['acme']);
    // Several apps share the limit.
    const two = appScopedDashboardEngine(spy, ['acme', 'globex']);
    await two.republishLifecycle?.({ workflow: 'job', limit: 1 });
    expect(seen).toEqual(['acme', 'acme']);
  });
});

describe('the viewer’s capabilities (console side)', () => {
  it('keep only what reaches durable’s console set; the full set when authorize names none', () => {
    expect(viewerConsoleCapabilities(undefined)).toEqual([
      'durable:read',
      'durable:runs:write',
      'durable:tasks:write',
      'durable:schedules:write',
    ]);
    expect(
      viewerConsoleCapabilities(['config:write', 'durable:read', 'durable:console:write', '*']),
    ).toEqual(['durable:read', 'durable:console:write', '*']);
    // A malformed or foreign-only grant allows nothing (fail closed).
    expect(viewerConsoleCapabilities(['flags:console:*'])).toEqual([]);
  });

  it("`access: 'read'` keeps reads only", () => {
    expect(viewerConsoleCapabilities(undefined, 'read')).toEqual(['durable:read']);
    expect(viewerConsoleCapabilities(['*'], 'read')).toEqual(['durable:read']);
    expect(viewerConsoleCapabilities(['durable:runs:write'], 'read')).toEqual([]);
  });

  it('narrow the console’s OWN app too: an action the viewer lacks is a 403, reads still answer', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, instanceId: 'own' });
    engine.register('approval', '1', async (ctx) => ctx.waitForSignal('approve'));
    await engine.start('approval', {}, 'run-1');
    await settle();
    const viewer = viewerScopedDashboardEngine(storeDashboardEngine(engine), ['durable:read']);
    await expect(
      cancelRun({ engine: viewer }, { params: { id: 'run-1' }, query: {} }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: '[@adonis-agora/durable] the viewer lacks durable:runs:write',
    });
    await expect(
      signalRun(
        { engine: viewer },
        {
          params: { id: 'run-1' },
          query: {},
          body: { token: 'approve', payload: {}, force: true },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await engine.getRun('run-1'))?.status).not.toBe('cancelled');
    expect(Array.isArray(await viewer.workerHealth())).toBe(true);
    // Full capabilities: the engine itself, untouched.
    const full = storeDashboardEngine(engine);
    expect(viewerScopedDashboardEngine(full, ['durable:console:*'])).toBe(full);
  });
});

describe('order of checks (verb → capabilities → token → viewer → partition/actions)', () => {
  it('a command that both the token and the viewer lack is refused for the token', async () => {
    const bus = new RedisBus();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, instanceId: 'shop' });
    const APP_KEY = 'app-key-of-the-shop-0123456789';
    const { consoleCommandPublicKey } = await import(
      '../../src/control-plane-redis/console-auth.js'
    );
    answerConsoleCommands(plane(bus), storeDashboardEngine(engine), undefined, {
      auth: {
        appKey: APP_KEY,
        verifyTenant: ({ token }) =>
          token === 't' ? { partition: 'other', capabilities: ['durable:read'] } : null,
      },
      partition: 'shop',
      actions: false,
    });
    const console = new FederatedApp({
      id: 'shop',
      store,
      controlPlane: plane(bus),
      auth: { token: 't', publicKey: consoleCommandPublicKey(APP_KEY, 'shop') },
    });
    // Token lacks it AND viewer lacks it AND wrong partition AND actions off: the token is named.
    await expect(console.engine('ops', ['durable:read']).cancel('r')).rejects.toMatchObject({
      message: "[@adonis-agora/durable] the console's token lacks durable:runs:write",
    });
    // The token allows reads, the viewer does not: the viewer is named before the partition.
    await expect(console.engine('ops', []).workerHealth()).rejects.toMatchObject({
      message: '[@adonis-agora/durable] the viewer lacks durable:read',
    });
    // Both allow: the partition rule.
    await expect(console.engine('ops', ['durable:read']).workerHealth()).rejects.toMatchObject({
      message: expect.stringMatching(/token is for "other", not "shop"/),
    });
  });
});

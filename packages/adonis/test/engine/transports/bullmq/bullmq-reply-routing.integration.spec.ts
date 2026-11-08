import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../../src/engine.js';
import type { StepResult } from '../../../../src/interfaces.js';
import { InMemoryStateStore } from '../../../../src/testing/in-memory-state-store.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import {
  type BullMQDeps,
  createBullMQDeps,
  type RedisLike,
  type WorkerLike,
} from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * Routed replies on a real Redis: a dispatched step's result goes back to the engine instance that
 * dispatched it (and holds the body parked on it), and is never lost when that instance is gone.
 * Gated on `DURABLE_REDIS_URL`, like the other real-Redis specs.
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const FAST = { replyAliveTtlMs: 600, replySweepMs: 100, replyDrainIdleMs: 1_000 };

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length)
    await closers
      .pop()?.()
      .catch(() => {});
});

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met');
}

/** Real deps that can be killed: every worker closed, every Redis client cut, with no goodbye. */
async function killableDeps(): Promise<BullMQDeps & { kill(): Promise<void> }> {
  const deps = await createBullMQDeps({ url: REDIS_URL } as unknown, 32);
  const workers: WorkerLike[] = [];
  const clients: RedisLike[] = [];
  return {
    ...deps,
    makeWorker(name, process, opts) {
      const worker = deps.makeWorker(name, process, opts);
      workers.push(worker);
      return worker;
    },
    makeRedis() {
      const client = deps.makeRedis();
      clients.push(client);
      return client;
    },
    async kill() {
      await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
      for (const client of clients) client.disconnect();
    },
  };
}

function setup(prefix: string) {
  const store = new InMemoryStateStore({ roundTripMethods: true });
  let entries = 0;
  const transport = async (id: string, opts: Record<string, unknown> = {}, deps?: BullMQDeps) => {
    const t = new BullMQTransport({
      deps: deps ?? (await createBullMQDeps({ url: REDIS_URL } as unknown, 32)),
      prefix,
      instanceId: id,
      ...FAST,
      ...opts,
    });
    closers.push(() => t.close());
    return t;
  };
  const engine = async (id: string, opts: Record<string, unknown> = {}, deps?: BullMQDeps) => {
    const t = await transport(id, opts, deps);
    const e = new WorkflowEngine({ store, transport: t, instanceId: id, reconcileMs: 0 });
    e.register('seq', '1', async (ctx, input) => {
      entries += 1;
      let total = 0;
      for (let i = 0; i < (input as { n: number }).n; i += 1) {
        total = await ctx.step<number>('reply.add', total);
      }
      return total;
    });
    closers.push(() => e.drain(1_000));
    return { engine: e, transport: t };
  };
  const worker = async (
    id: string,
    opts: Record<string, unknown> = {},
    gate?: () => Promise<void>,
  ) => {
    const t = await transport(id, opts);
    t.handle('reply.add', async (input: unknown) => {
      await gate?.();
      return (input as number) + 1;
    });
    return t;
  };
  const sticky = (e: WorkflowEngine) =>
    (e as unknown as { sticky: { hits: number; misses: number } }).sticky;
  return { store, engine, worker, sticky, entries: () => entries };
}

const completed = async (store: InMemoryStateStore, ids: string[]) =>
  (await Promise.all(ids.map((id) => store.getRun(id)))).every((r) => r?.status === 'completed');

describe.skipIf(!REDIS_URL)('routed step results (BullMQ)', () => {
  it('go back to the engine that dispatched them, so no body replays', async () => {
    // (Either engine may take a run off the run queue; whichever runs its turns gets its results.)
    const env = setup(uniqueRedisPrefix('rr'));
    const a = await env.engine('engine-a');
    const b = await env.engine('engine-b');
    await env.worker('worker-1');
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const id = `r${i}`;
      ids.push(id);
      await (i % 2 ? b : a).engine.start('seq', { n: 5 }, id);
    }
    await until(() => completed(env.store, ids));
    for (const id of ids) expect((await env.store.getRun(id))?.output).toBe(5);
    // Each body ran once: every result reached the engine holding it.
    expect(env.entries()).toBe(6);
    expect(env.sticky(a.engine).hits + env.sticky(b.engine).hits).toBeGreaterThanOrEqual(30);
  });

  it('without routing, results land on either engine and bodies replay (the control case)', async () => {
    const env = setup(uniqueRedisPrefix('rr'));
    const a = await env.engine('engine-a', { replyRouting: false });
    const b = await env.engine('engine-b', { replyRouting: false });
    await env.worker('worker-1');
    const ids = ['x0', 'x1', 'x2', 'x3', 'x4', 'x5'];
    for (const [i, id] of ids.entries()) await (i % 2 ? b : a).engine.start('seq', { n: 5 }, id);
    await until(() => completed(env.store, ids));
    for (const id of ids) expect((await env.store.getRun(id))?.output).toBe(5);
    expect(env.entries()).toBeGreaterThan(6);
  });

  it('of an engine that died are moved to the shared results and finish the run elsewhere', async () => {
    const prefix = uniqueRedisPrefix('rr');
    const env = setup(prefix);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const deadDeps = await killableDeps();
    const a = await env.engine('engine-a', {}, deadDeps);
    await env.worker('worker-1', {}, () => gate);
    // A alone takes the run off the run queue, so the body is parked on A.
    await a.engine.start('seq', { n: 2 }, 'd1');
    await until(async () => (await env.store.getRun('d1'))?.status === 'suspended');
    expect(env.entries()).toBe(1);
    await env.engine('engine-b');
    // Engine A crashes: it stops consuming and beating, without the goodbye a shutdown sends.
    await deadDeps.kill();
    // The step finishes while A's alive key may still stand: its result goes to A's own queue, or
    // to the shared one once the key lapsed. Either way engine B finishes the run (replaying it).
    open();
    await until(async () => (await env.store.getRun('d1'))?.status === 'completed');
    expect((await env.store.getRun('d1'))?.output).toBe(2);
    const probe = await createBullMQDeps({ url: REDIS_URL } as unknown, 1);
    const queue = probe.makeQueue(`${prefix}-results-to-engine-a`);
    closers.push(() => queue.close());
    const left = await queue.getJobCounts('waiting', 'wait', 'active', 'delayed');
    expect(Object.values(left).reduce((sum, n) => sum + n, 0)).toBe(0);
    expect(env.entries()).toBe(2);
  });

  it('settle a duplicate delivery once, whichever queue each copy came on', async () => {
    const prefix = uniqueRedisPrefix('rr');
    const env = setup(prefix);
    const a = await env.engine('engine-a');
    const events: string[] = [];
    a.engine.subscribe((e) => {
      if (e.type === 'step.completed') events.push(`${e.runId}:${e.seq}`);
    });
    // No worker: the test delivers the result itself, twice, on both queues.
    await a.engine.start('seq', { n: 1 }, 'dup');
    await until(async () => (await env.store.getRun('dup'))?.status === 'suspended');
    // The alive key is up once consuming has started.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cp = (await env.store.listCheckpoints('dup'))[0];
    if (!cp) throw new Error('no checkpoint');
    const result: StepResult = {
      runId: 'dup',
      seq: cp.seq,
      stepId: cp.stepId ?? '',
      status: 'completed',
      output: 1,
    };
    const probe = await createBullMQDeps({ url: REDIS_URL } as unknown, 1);
    const own = probe.makeQueue(`${prefix}-results-to-engine-a`);
    const shared = probe.makeQueue(`${prefix}-results`);
    closers.push(
      () => own.close(),
      () => shared.close(),
    );
    await Promise.all([own.add('result', result), shared.add('result', result)]);
    await until(async () => (await env.store.getRun('dup'))?.status === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events).toEqual([`dup:${cp.seq}`]);
    expect((await env.store.getRun('dup'))?.output).toBe(1);
  });

  it('work in a rolling deploy mixing engines and workers that route replies and ones that do not', async () => {
    const env = setup(uniqueRedisPrefix('rr'));
    const newer = await env.engine('engine-new');
    const older = await env.engine('engine-old', { replyRouting: false });
    await env.worker('worker-new');
    await env.worker('worker-old', { replyRouting: false });
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      ids.push(`m${i}`);
      await (i % 2 ? older : newer).engine.start('seq', { n: 4 }, `m${i}`);
    }
    await until(() => completed(env.store, ids), 30_000);
    for (const id of ids) {
      expect((await env.store.getRun(id))?.output).toBe(4);
      // Every step settled once.
      const cps = await env.store.listCheckpoints(id);
      expect(cps.map((c) => [c.status, c.attempts])).toEqual(
        Array.from({ length: 4 }, () => ['completed', 1]),
      );
    }
  });

  it('a process whose consumers are deferred announces nothing, and its results stay shared', async () => {
    const prefix = uniqueRedisPrefix('rr');
    const deps = await createBullMQDeps({ url: REDIS_URL } as unknown, 4);
    const t = new BullMQTransport({ deps, prefix, instanceId: 'cli', ...FAST });
    closers.push(() => t.close());
    t.deferConsumers();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: t, instanceId: 'cli', reconcileMs: 0 });
    closers.push(() => engine.drain(1_000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const redis = deps.makeRedis();
    closers.push(async () => redis.disconnect());
    expect(await redis.exists?.(`${prefix}:reply-alive:cli`)).toBe(0);
    t.startConsumers();
    await until(async () => (await redis.exists?.(`${prefix}:reply-alive:cli`)) === 1, 5_000);
    // A clean shutdown takes the key down first.
    await t.close();
    expect(await redis.exists?.(`${prefix}:reply-alive:cli`)).toBe(0);
  });
});

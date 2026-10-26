import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  Heartbeat,
  RemoteTask,
  StateStore,
  StepResult,
  Transport,
} from '../../src/interfaces.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import type { BullMQDeps, QueueLike } from '../../src/transports/bullmq/deps.js';
import { QueueTransport } from '../../src/transports/queue.js';
import { MockAdapter } from '../../src/transports/queue-mock-adapter.js';

/**
 * What a wide step fan costs on its way out and while its steps run. Sending N steps groups them
 * by task queue in O(N). Every step's worker beats once when it picks the step up; those N beats
 * must not become N concurrent store writes competing with the fan's results for connections, nor,
 * with the lost-dispatch self-heal on, a read and a lease write per step.
 */

const STEP = 'lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = STEP;

class CapturingTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result: ((r: StepResult) => Promise<void>) | undefined;
  beat: ((b: Heartbeat) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    this.dispatched.push(...tasks);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(handler: (b: Heartbeat) => Promise<void>): void {
    this.beat = handler;
  }
}

/** Counts store calls by name, each answering a few ms later, with the most in flight at once. */
function counting(inner: StateStore, delayMs = 3) {
  const calls = new Map<string, number>();
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return async (...args: unknown[]) => {
        calls.set(prop, (calls.get(prop) ?? 0) + 1);
        const now = (inFlight.get(prop) ?? 0) + 1;
        inFlight.set(prop, now);
        peak.set(prop, Math.max(peak.get(prop) ?? 0, now));
        try {
          await new Promise((r) => setTimeout(r, delayMs));
          return await (value as (...a: unknown[]) => unknown).apply(target, args);
        } finally {
          inFlight.set(prop, (inFlight.get(prop) ?? 1) - 1);
        }
      };
    },
  }) as unknown as StateStore;
  return {
    store,
    count: (name: string) => calls.get(name) ?? 0,
    peak: (name: string) => peak.get(name) ?? 0,
    reset: () => {
      calls.clear();
      peak.clear();
    },
  };
}

async function until(check: () => boolean | Promise<boolean>, budgetMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > budgetMs) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function fan(store: StateStore, n: number, opts: { remoteRedispatchMs?: number } = {}) {
  const transport = new CapturingTransport();
  const engine = new WorkflowEngine({ store, transport, reconcileMs: 0, ...opts });
  engine.register('fan', '1', async (ctx) =>
    ctx.all(
      processLine,
      Array.from({ length: n }, (_, i) => ({ i })),
    ),
  );
  await engine.start('fan', {}, 'p');
  await until(() => transport.dispatched.length === n);
  await until(async () => (await store.getRun('p'))?.status === 'suspended');
  return { engine, transport };
}

const pickup = (task: RemoteTask): Heartbeat => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  group: task.group,
  at: Date.now(),
});

const done = (task: RemoteTask): StepResult => ({
  runId: task.runId,
  seq: task.seq,
  stepId: task.stepId,
  status: 'completed',
  output: (task.input as { i: number }).i,
});

describe('a wide fan’s pickup beats', () => {
  it('are written one at a time, and not at all for a step that finished first', async () => {
    const inner = new InMemoryStateStore();
    const counted = counting(inner);
    const { engine, transport } = await fan(counted.store, 200);
    const tasks = transport.dispatched;

    await Promise.all(tasks.map((task) => transport.beat?.(pickup(task))));
    await Promise.all(tasks.slice(1).map((task) => transport.result?.(done(task))));
    await until(
      async () =>
        (await inner.getCheckpoint('p', (tasks[0] as RemoteTask).seq))?.lastHeartbeatAt !==
        undefined,
    );

    expect(counted.peak('recordStepHeartbeat')).toBe(1);
    expect(counted.count('recordStepHeartbeat')).toBeLessThan(tasks.length / 2);
    // The step still running has its beat on the checkpoint.
    const running = await inner.getCheckpoint('p', (tasks[0] as RemoteTask).seq);
    expect(running?.status).toBe('pending');
    expect(running?.lastHeartbeatAt).toBeInstanceOf(Date);

    await transport.result?.(done(tasks[0] as RemoteTask));
    expect((await engine.waitForRun('p', { terminal: true })).status).toBe('completed');
  });

  it('with the lost-dispatch self-heal on, find each step’s lease already stamped at send', async () => {
    const inner = new InMemoryStateStore();
    const counted = counting(inner);
    const before = Date.now();
    const { transport } = await fan(counted.store, 200, { remoteRedispatchMs: 60_000 });
    const tasks = transport.dispatched;

    const checkpoints = await inner.listCheckpoints('p');
    expect(checkpoints).toHaveLength(200);
    for (const cp of checkpoints) expect(cp.wakeAt).toBeGreaterThanOrEqual(before + 60_000);
    // The run parks on the lease, so a fan whose dispatch is lost is re-driven.
    expect((await inner.getRun('p'))?.wakeAt).toBeDefined();

    counted.reset();
    await Promise.all(tasks.map((task) => transport.beat?.(pickup(task))));
    expect(counted.count('getCheckpoint')).toBe(0);
    expect(counted.count('saveCheckpoint')).toBe(0);
  });
});

describe('sending a wide fan', () => {
  const N = 150_000;
  const tasks = Array.from(
    { length: N },
    (_, i): RemoteTask => ({
      runId: 'p',
      seq: i + 1,
      name: STEP,
      stepId: `p:${i + 1}`,
      group: STEP,
      input: { i },
      attempt: 1,
    }),
  );

  it('groups its tasks by queue in linear time (bullmq)', async () => {
    let sent = 0;
    const queue: QueueLike = {
      add: async () => ({}),
      addBulk: async (jobs: unknown[]) => {
        sent += jobs.length;
        return [];
      },
      getJobCounts: async () => ({}),
      close: async () => undefined,
    } as QueueLike;
    const deps = {
      makeQueue: () => queue,
      makeWorker: () => ({ on: () => undefined, close: async () => undefined }),
      makeRedis: () => ({}),
    } as unknown as BullMQDeps;
    const transport = new BullMQTransport({ deps, prefix: 'wide' });

    const start = performance.now();
    await transport.dispatchMany(tasks);
    expect(sent).toBe(N);
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('groups its tasks by queue in linear time (queue)', async () => {
    const adapter = new MockAdapter();
    const transport = new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 });
    try {
      const start = performance.now();
      await transport.dispatchMany(tasks);
      expect(performance.now() - start).toBeLessThan(3_000);
    } finally {
      await transport.close();
    }
  });
});

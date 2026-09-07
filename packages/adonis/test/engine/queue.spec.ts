import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { QueueController } from '../../src/queue.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/** Drive the InMemoryTransport's deferred results until `runId` reaches a terminal state. */
async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

/** A transport that holds dispatches so a test can control when (and whether) a step completes. */
class ManualTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  private result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
  async complete(task: RemoteTask): Promise<void> {
    await this.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { pong: true },
    });
  }
}

describe('QueueController — admission gate', () => {
  it('is plain FIFO when no priority/key is given (backward compatible)', () => {
    const now = 0;
    const q = new QueueController({ name: 'q', concurrency: 1 }, () => now);
    // First admit takes the only slot.
    expect(q.tryAdmit().ok).toBe(true);
    // Second is blocked until the retry window.
    const blocked = q.tryAdmit();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAt).toBe(now + 1000);
    // Releasing frees the slot; the next admit succeeds.
    q.release();
    expect(q.tryAdmit().ok).toBe(true);
  });

  it('respects the fixed-window rate limit regardless of priority', () => {
    let now = 1000;
    const q = new QueueController(
      { name: 'q', rateLimit: { limit: 2, periodMs: 1000 } },
      () => now,
    );
    expect(q.tryAdmit({ priority: 10 }).ok).toBe(true);
    expect(q.tryAdmit({ priority: 10 }).ok).toBe(true);
    const blocked = q.tryAdmit({ priority: 99 }); // even max priority can't beat the window
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAt).toBe(2000);
    now = 2000; // window reset
    expect(q.tryAdmit({ priority: 1 }).ok).toBe(true);
  });

  it('admits higher-priority waiters before lower-priority ones when a slot is contended', () => {
    let now = 0;
    const q = new QueueController({ name: 'q', concurrency: 1 }, () => now);
    expect(q.tryAdmit({ key: 'a', priority: 1 }).ok).toBe(true); // takes the slot
    // Two waiters register while the slot is busy: low then high priority.
    const low = q.tryAdmit({ key: 'b', priority: 1, waiterId: 'low' });
    const high = q.tryAdmit({ key: 'c', priority: 5, waiterId: 'high' });
    expect(low.ok).toBe(false);
    expect(high.ok).toBe(false);
    q.release(); // one slot frees
    now += 1000;
    // High priority wins the freed slot; low priority still waits.
    expect(q.tryAdmit({ key: 'c', priority: 5, waiterId: 'high' }).ok).toBe(true);
    expect(q.tryAdmit({ key: 'b', priority: 1, waiterId: 'low' }).ok).toBe(false);
  });

  it('round-robins across keys so one key cannot monopolize the budget (fairness)', () => {
    let now = 0;
    const q = new QueueController({ name: 'q', concurrency: 1, fairness: 'key' }, () => now);
    expect(q.tryAdmit({ key: 'noisy', waiterId: 'n1' }).ok).toBe(true); // slot taken by noisy
    // While busy: noisy enqueues two more, quiet enqueues one. Fairness must not let noisy take
    // both freed slots before quiet gets one.
    q.tryAdmit({ key: 'noisy', waiterId: 'n2' });
    q.tryAdmit({ key: 'noisy', waiterId: 'n3' });
    q.tryAdmit({ key: 'quiet', waiterId: 'q1' });
    q.release();
    now += 1000;
    // The freed slot goes to the under-served key (quiet), not the next noisy item.
    expect(q.tryAdmit({ key: 'noisy', waiterId: 'n2' }).ok).toBe(false);
    expect(q.tryAdmit({ key: 'quiet', waiterId: 'q1' }).ok).toBe(true);
    // After quiet is served, the next slot goes back to noisy.
    q.release();
    now += 1000;
    expect(q.tryAdmit({ key: 'noisy', waiterId: 'n2' }).ok).toBe(true);
  });

  it('priority takes precedence over fairness, fairness breaks ties within a priority', () => {
    let now = 0;
    const q = new QueueController({ name: 'q', concurrency: 1, fairness: 'key' }, () => now);
    expect(q.tryAdmit({ key: 'x', waiterId: 'x0' }).ok).toBe(true);
    // Same priority across two keys, plus one higher-priority item on the noisy key.
    q.tryAdmit({ key: 'noisy', priority: 1, waiterId: 'n1' });
    q.tryAdmit({ key: 'quiet', priority: 1, waiterId: 'q1' });
    q.tryAdmit({ key: 'noisy', priority: 9, waiterId: 'n2' });
    q.release();
    now += 1000;
    // Highest priority wins regardless of key.
    expect(q.tryAdmit({ key: 'noisy', priority: 9, waiterId: 'n2' }).ok).toBe(true);
  });

  it('admits the most recent arrival first with order: lifo (a stack)', () => {
    let now = 0;
    const q = new QueueController({ name: 'q', concurrency: 1, order: 'lifo' }, () => now);
    expect(q.tryAdmit({ waiterId: 'first' }).ok).toBe(true); // takes the slot
    // Two equal-priority waiters register while the slot is busy: 'a' then 'b'.
    q.tryAdmit({ waiterId: 'a' });
    q.tryAdmit({ waiterId: 'b' });
    q.release();
    now += 1000;
    // LIFO: the most recently-arrived waiter ('b') wins the freed slot; 'a' still waits.
    expect(q.tryAdmit({ waiterId: 'a' }).ok).toBe(false);
    expect(q.tryAdmit({ waiterId: 'b' }).ok).toBe(true);
  });
});

describe('flow control — durable queues', () => {
  it('rate-limits admissions per queue and resumes blocked calls when the window resets', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('ext.ping', async () => ({ pong: true }));
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.registerQueue({ name: 'api', rateLimit: { limit: 2, periodMs: 1000 } });
    engine.register('caller', '1', async (ctx) => {
      await ctx.step('ext.ping', {}, { queue: 'api' });
      return 'done';
    });

    await startRun(engine, 'caller', {}, 'a');
    await startRun(engine, 'caller', {}, 'b');
    const c = await startRun(engine, 'caller', {}, 'c');

    // a and b are admitted within the window; c exceeds the limit → suspended, not dispatched.
    expect(c.status).toBe('suspended');
    await settle(store, 'a');
    await settle(store, 'b');
    expect((await store.getRun('c'))?.status).toBe('suspended');
    expect((await store.getRun('c'))?.output).toBeUndefined();

    // Advance past the window → the blocked call is admitted on resume.
    nowMs += 1000;
    await engine.resumeDueTimers(nowMs);
    expect((await settle(store, 'c')).status).toBe('completed');
  });

  it('limits concurrent in-flight steps per queue, admitting the next when a slot frees', async () => {
    const store = new InMemoryStateStore();
    const transport = new ManualTransport();
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.registerQueue({ name: 'db', concurrency: 1 });
    engine.register('caller', '1', async (ctx) => {
      await ctx.step('ext.ping', {}, { queue: 'db' });
      return 'done';
    });

    await startRun(engine, 'caller', {}, 'a'); // admitted → in-flight (1/1)
    await startRun(engine, 'caller', {}, 'b'); // blocked (1 >= 1) → suspended
    expect(transport.dispatched).toHaveLength(1);
    expect((await store.getRun('b'))?.status).toBe('suspended');

    // Complete a → frees the slot.
    const [firstTask] = transport.dispatched;
    if (!firstTask) throw new Error('expected a dispatched task');
    await transport.complete(firstTask);
    await new Promise((r) => setImmediate(r));
    expect((await store.getRun('a'))?.status).toBe('completed');

    // Resume b (its retry timer is due) → now admitted and dispatched.
    nowMs += 1000;
    await engine.resumeDueTimers(nowMs);
    expect(transport.dispatched).toHaveLength(2);
    const secondTask = transport.dispatched[1];
    if (!secondTask) throw new Error('expected a second dispatched task');
    await transport.complete(secondTask);
    await new Promise((r) => setImmediate(r));
    expect((await store.getRun('b'))?.status).toBe('completed');
  });

  it('admits a higher-priority queued call before a lower-priority one when a slot frees', async () => {
    const store = new InMemoryStateStore();
    const transport = new ManualTransport();
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.registerQueue({ name: 'pq', concurrency: 1 });
    engine.register('lo', '1', async (ctx) => {
      await ctx.step('ext.ping', {}, { queue: 'pq', priority: 1 });
      return 'done';
    });
    engine.register('hi', '1', async (ctx) => {
      await ctx.step('ext.ping', {}, { queue: 'pq', priority: 9 });
      return 'done';
    });

    // Take the only slot with a first low-priority run.
    await startRun(engine, 'lo', {}, 'first');
    expect(transport.dispatched).toHaveLength(1);
    // Two contenders register as blocked: low then high priority.
    await startRun(engine, 'lo', {}, 'low');
    await startRun(engine, 'hi', {}, 'high');
    expect((await store.getRun('low'))?.status).toBe('suspended');
    expect((await store.getRun('high'))?.status).toBe('suspended');

    // Free the slot; on resume the HIGH priority run is admitted before the low one.
    const [firstTask] = transport.dispatched;
    if (firstTask) await transport.complete(firstTask);
    await new Promise((r) => setImmediate(r));
    nowMs += 1000;
    await engine.resumeDueTimers(nowMs);
    // Exactly one new dispatch, and it belongs to the high-priority run.
    expect(transport.dispatched).toHaveLength(2);
    expect(transport.dispatched[1]?.runId).toBe('high');
  });
});

describe('sliding-window rate limit', () => {
  it('admits smoothly over a rolling window instead of bursting at boundaries', async () => {
    const { QueueController } = await import('../../src/queue.js');
    let nowMs = 0;
    const q = new QueueController(
      { name: 'api', rateLimit: { limit: 2, periodMs: 1_000, algorithm: 'sliding' } },
      () => nowMs,
    );
    expect(q.tryAdmit().ok).toBe(true); // t=0
    nowMs = 900;
    expect(q.tryAdmit().ok).toBe(true); // t=900
    // Window [−50, 950] holds both admissions — denied, with the PRECISE earliest retry (t=0 ages
    // out at 1000). A fixed window would already have reset at the boundary and allowed a 2× burst.
    nowMs = 950;
    const denied = q.tryAdmit();
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.retryAt).toBe(1_000);
    nowMs = 1_050; // t=0 aged out → one slot free
    expect(q.tryAdmit().ok).toBe(true);
    nowMs = 1_100;
    expect(q.tryAdmit().ok).toBe(false); // t=900 + t=1050 still inside the window
    nowMs = 1_950; // t=900 aged out
    expect(q.tryAdmit().ok).toBe(true);
  });
});

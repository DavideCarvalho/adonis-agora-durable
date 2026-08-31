import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport, toJson } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

// The transport bypasses the broker's `Worker` class (see queue.ts header), so nothing called the
// adapter's `recoverStalledJobs` — a claim whose worker died between `popFrom` and `completeJob` sat
// in `active` forever. These cover the sweep that restores that recovery.

const POLL = 5;
const CHECK = 5;
const THRESHOLD = 20;
const TASKS_QUEUE = 'durable:tasks:ext.echo';
const RESULTS_QUEUE = 'durable:results';

/** Wait until `cond()` is true (poll loops are async) or fail after a budget. */
async function until(cond: () => boolean, budgetMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const task = (over: Partial<RemoteTask> = {}): RemoteTask => {
  const name = over.name ?? 'ext.echo';
  return {
    runId: 'r1',
    seq: 1,
    name,
    stepId: 'r1:1',
    group: sanitizeQueueToken(name),
    input: { hello: 'world' },
    attempt: 1,
    ...over,
  };
};

describe('QueueTransport stalled-job reclaim', () => {
  const transports: QueueTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    vi.restoreAllMocks();
  });

  it('re-delivers a claimed-but-never-completed task after the threshold; it completes on the second delivery', async () => {
    const adapter = new MockAdapter();
    const engine = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: THRESHOLD,
    });
    transports.push(engine);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));

    // A dispatched task, then a worker that CLAIMS it and dies before completing — the job is now wedged
    // in `active` with an `acquiredAt`, with nothing to reclaim it (the crash the transport never handled).
    await engine.dispatch(task());
    const dead = await adapter.popFrom(TASKS_QUEUE);
    expect(dead).not.toBeNull();
    expect(adapter.active.has(dead!.id)).toBe(true);

    // A healthy worker joins. Its task loop finds `pending` empty (the job is still claimed), but its
    // reclaim sweep moves the stale claim back to `pending`, where the loop then runs it to completion.
    let runs = 0;
    const worker = new QueueTransport({
      adapter: () => adapter,
      group: 'ext',
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: THRESHOLD,
    });
    transports.push(worker);
    worker.handle('ext.echo', async (input) => {
      runs += 1;
      return { echoed: input };
    });

    await until(() => results.length === 1);
    expect(runs).toBe(1); // only the reclaimed (second) delivery ran
    expect(results[0]!.status).toBe('completed');
    expect(results[0]!.output).toEqual({ echoed: { hello: 'world' } });
    expect(results[0]!.stepId).toBe('r1:1');
    expect(adapter.active.size).toBe(0); // the reclaimed job was completed, not left dangling
  });

  it('does NOT reclaim a fresh claim (younger than the threshold)', async () => {
    const adapter = new MockAdapter();
    const engine = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: 10_000, // far longer than this test runs → no claim ever stalls
    });
    transports.push(engine);
    engine.onResult(async () => {});

    await engine.dispatch(task());
    const dead = await adapter.popFrom(TASKS_QUEUE);
    expect(dead).not.toBeNull();

    let runs = 0;
    const worker = new QueueTransport({
      adapter: () => adapter,
      group: 'ext',
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: 10_000,
    });
    transports.push(worker);
    worker.handle('ext.echo', async () => {
      runs += 1;
      return 'ok';
    });

    // Give several sweep + poll cycles a chance to (wrongly) reclaim, then assert the claim stood.
    await new Promise((r) => setTimeout(r, CHECK * 8));
    expect(runs).toBe(0);
    expect(adapter.active.has(dead!.id)).toBe(true);
    expect(await adapter.sizeOf(TASKS_QUEUE)).toBe(0);

    // And the mock's own semantics, deterministically: a large threshold reclaims nothing.
    const n = await adapter.recoverStalledJobs(TASKS_QUEUE, 10_000, 3);
    expect(n).toBe(0);
  });

  it('an adapter without recoverStalledJobs does not crash — the sweep is skipped', async () => {
    const adapter = new MockAdapter();
    // Simulate a driver that never implemented the capability.
    (adapter as unknown as { recoverStalledJobs?: unknown }).recoverStalledJobs = undefined;

    const engine = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: THRESHOLD,
    });
    const worker = new QueueTransport({
      adapter: () => adapter,
      group: 'ext',
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: THRESHOLD,
    });
    transports.push(engine, worker);

    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    worker.handle('ext.echo', async (input) => ({ echoed: input }));

    // Normal dispatch still round-trips; nothing throws despite the missing method.
    await engine.dispatch(task());
    await until(() => results.length === 1);
    expect(results[0]!.status).toBe('completed');
  });

  it('re-delivering a task whose result already landed does not corrupt anything (duplicate result flows; dedup is the engine’s job)', async () => {
    const adapter = new MockAdapter();
    const engine = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: THRESHOLD,
    });
    transports.push(engine);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));

    // The production shape: the worker published its result, then crashed BEFORE completeJob — so the
    // result is already on the results queue AND the task is still claimed in `active`.
    await engine.dispatch(task());
    const dead = await adapter.popFrom(TASKS_QUEUE);
    expect(dead).not.toBeNull();
    const landed: StepResult = {
      runId: 'r1',
      seq: 1,
      stepId: 'r1:1',
      status: 'completed',
      output: { echoed: { hello: 'world' } },
    };
    await adapter.pushOn(RESULTS_QUEUE, {
      id: randomUUID(),
      name: 'result',
      payload: toJson(landed),
      attempts: 0,
      createdAt: Date.now(),
    });

    // A healthy worker reclaims the stale task and re-runs the (idempotent) step, producing a SECOND
    // result for the same stepId. The transport faithfully delivers both — it does not dedup; the engine
    // ignores results for an already-completed checkpoint. Assert current behavior, no corruption/crash.
    const worker = new QueueTransport({
      adapter: () => adapter,
      group: 'ext',
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: THRESHOLD,
    });
    transports.push(worker);
    worker.handle('ext.echo', async (input) => ({ echoed: input }));

    await until(() => results.length === 2);
    expect(results.map((r) => r.stepId)).toEqual(['r1:1', 'r1:1']);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(adapter.active.size).toBe(0);
  });
});

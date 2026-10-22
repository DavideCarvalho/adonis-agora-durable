import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

// The transport bypasses `@boringnode/queue`'s `Worker`, so it also bypassed that class's heartbeat:
// a claim's `acquiredAt` was never renewed, its age was the step's runtime, and the stalled threshold
// had to exceed the longest step. These cover the renewal that makes the age measure worker silence.

const POLL = 5;
const CHECK = 5;
const THRESHOLD = 40;
const TASKS_QUEUE = 'durable:tasks:ext.slow';

async function until(cond: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const task = (over: Partial<RemoteTask> = {}): RemoteTask => {
  const name = over.name ?? 'ext.slow';
  return {
    runId: 'r1',
    seq: 1,
    name,
    stepId: 'r1:1',
    group: sanitizeQueueToken(name),
    input: {},
    attempt: 1,
    ...over,
  };
};

/** An adapter without `renewJobs` (every `@adonisjs/queue` driver has it — a custom one may not). */
class NonRenewingAdapter extends MockAdapter {
  constructor() {
    super();
    (this as { renewJobs?: unknown }).renewJobs = undefined;
  }
}

describe('QueueTransport claim renewal', () => {
  const transports: QueueTransport[] = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    vi.restoreAllMocks();
  });

  const make = (
    adapter: MockAdapter,
    extra: Partial<ConstructorParameters<typeof QueueTransport>[0]> = {},
  ) => {
    const t = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: CHECK,
      stalledThresholdMs: THRESHOLD,
      ...extra,
    });
    transports.push(t);
    return t;
  };

  it('a step that runs many times longer than the threshold is NOT re-delivered while its worker is alive', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));

    let runs = 0;
    const worker = make(adapter);
    worker.handle('ext.slow', async () => {
      runs += 1;
      await sleep(THRESHOLD * 6);
      return 'done';
    });

    await engine.dispatch(task());
    await until(() => results.length === 1);
    // The worker's own sweep walked the tasks queue every CHECK ms and saw a fresh claim each round.
    expect(runs).toBe(1);
    expect(results[0]).toMatchObject({ status: 'completed', output: 'done' });
    expect(adapter.active.size).toBe(0);
  });

  it('a dead worker’s claim (no renewal) is still re-delivered within the threshold', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));

    await engine.dispatch(task());
    // Claimed outside any transport: nobody renews it — the crashed-worker shape.
    expect(await adapter.popFrom(TASKS_QUEUE)).not.toBeNull();

    const worker = make(adapter);
    worker.handle('ext.slow', async () => 'recovered');
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({ status: 'completed', output: 'recovered' });
  });

  it('renews only claims it still holds, and reports a lost claim through onError', async () => {
    const adapter = new MockAdapter();
    const errors: unknown[] = [];
    const engine = make(adapter, { stalledCheckIntervalMs: 0 });
    engine.onResult(async () => {});

    const releases: Array<() => void> = [];
    const worker = make(adapter, {
      stalledCheckIntervalMs: 0,
      onError: (err) => errors.push(err),
    });
    worker.handle('ext.slow', () => new Promise((r) => releases.push(() => r('late'))));

    await engine.dispatch(task());
    await until(() => adapter.active.size === 1);
    // Another instance's sweep re-delivers the claim behind the worker's back (it went silent).
    const [id, job] = [...adapter.active][0] as [string, { acquiredAt: number }];
    adapter.active.set(id, { ...adapter.active.get(id)!, acquiredAt: job.acquiredAt - 10_000 });
    await adapter.recoverStalledJobs(TASKS_QUEUE, THRESHOLD, 3, 100);

    await until(() => errors.length > 0);
    expect(String(errors[0])).toMatch(/lost 1 of 1 claim/);
    for (const release of releases) release();
    await until(() => releases.length === 2);
    for (const release of releases) release();
  });

  it('a job that completes while a renewal is in flight is not reported as lost', async () => {
    const adapter = new MockAdapter();
    const errors: unknown[] = [];
    const t = make(adapter, { stalledCheckIntervalMs: 0, onError: (err) => errors.push(err) });
    t.onResult(async () => {});

    let release!: () => void;
    t.handle('ext.slow', () => new Promise((r) => (release = () => r('ok'))));
    // The renewal round-trip is slow enough for the step to finish (and be finalized) inside it.
    const original = adapter.renewJobs.bind(adapter);
    let completedDuringRenew = false;
    vi.spyOn(adapter, 'renewJobs').mockImplementation(async (queue, jobs) => {
      release();
      await until(() => adapter.active.size === 0);
      completedDuringRenew = true;
      return original(queue, jobs);
    });

    await t.dispatch(task());
    await until(() => completedDuringRenew);
    await sleep(THRESHOLD);
    expect(errors).toEqual([]);
  });

  it('defaults the threshold to 2min when the adapter renews, 30min when it has no renewJobs', async () => {
    const renewing = new MockAdapter();
    const legacy = new NonRenewingAdapter();
    const renewingSweep = vi.spyOn(renewing, 'recoverStalledJobs');
    const legacySweep = vi.spyOn(legacy, 'recoverStalledJobs');
    for (const adapter of [renewing, legacy]) {
      const t = new QueueTransport({
        adapter: () => adapter,
        pollIntervalMs: POLL,
        stalledCheckIntervalMs: CHECK,
      });
      transports.push(t);
      t.onResult(async () => {});
    }
    await until(() => renewingSweep.mock.calls.length > 0 && legacySweep.mock.calls.length > 0);
    expect(renewingSweep.mock.calls[0]?.[1]).toBe(120_000);
    expect(legacySweep.mock.calls[0]?.[1]).toBe(1_800_000);
  });

  it('an explicit stalledThresholdMs wins over either default', async () => {
    const adapter = new MockAdapter();
    const sweep = vi.spyOn(adapter, 'recoverStalledJobs');
    const t = make(adapter, { stalledThresholdMs: 7_000 });
    t.onResult(async () => {});
    await until(() => sweep.mock.calls.length > 0);
    expect(sweep.mock.calls[0]?.[1]).toBe(7_000);
  });

  it('close() stops renewing', async () => {
    const adapter = new MockAdapter();
    const renew = vi.spyOn(adapter, 'renewJobs');
    const t = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: 0,
      stalledThresholdMs: 10,
    });
    let release!: () => void;
    t.handle('ext.slow', () => new Promise((r) => (release = () => r('x'))));
    await t.dispatch(task());
    await until(() => renew.mock.calls.length > 0);
    release();
    await t.close();
    const after = renew.mock.calls.length;
    await sleep(40);
    expect(renew.mock.calls.length).toBe(after);
  });
});

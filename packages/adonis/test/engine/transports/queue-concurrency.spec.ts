import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTask, StepResult } from '../../../src/interfaces.js';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

// Each step name's task loop used to await one job before popping the next: a worker ran ONE job
// of a given step at a time, whatever the backlog. And every loop polled at the base interval
// forever, so an idle worker serving many step names hammered the backend. These cover the
// `concurrency` slots and the idle backoff.

const POLL = 5;

async function until(cond: () => boolean, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const task = (seq: number, name = 'ext.work'): RemoteTask => ({
  runId: 'r1',
  seq,
  name,
  stepId: `r1:${seq}`,
  group: sanitizeQueueToken(name),
  input: { seq },
  attempt: 1,
});

describe('QueueTransport concurrency and idle backoff', () => {
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
      stalledCheckIntervalMs: 0,
      ...extra,
    });
    transports.push(t);
    return t;
  };

  /**
   * Run `jobs` slow steps through a worker with `concurrency` slots; report the peak in flight. The
   * backlog is queued before the worker starts, and each step holds its slot until `expected` steps
   * run together (bounded), so the peak depends on the slot loop alone, not on how dispatches and
   * 30ms sleeps overlapped on a loaded machine. The barrier never caps the peak: over-running shows.
   */
  async function peakInFlight(concurrency: number | undefined, jobs: number, expected: number) {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    for (let i = 1; i <= jobs; i += 1) await engine.dispatch(task(i));
    let running = 0;
    let peak = 0;
    let done = 0;
    const worker = make(adapter, concurrency === undefined ? {} : { concurrency });
    worker.handle('ext.work', async (input) => {
      running += 1;
      peak = Math.max(peak, running);
      await until(() => running >= Math.min(expected, jobs - done), 3000).catch(() => undefined);
      await sleep(30);
      running -= 1;
      done += 1;
      return input;
    });
    await until(() => results.length === jobs);
    return { peak, results, adapter };
  }

  it('runs one job at a time by default', async () => {
    const { peak } = await peakInFlight(undefined, 4, 1);
    expect(peak).toBe(1);
  });

  it('runs up to `concurrency` jobs of one step at once, and never more', async () => {
    const { peak, results, adapter } = await peakInFlight(3, 10, 3);
    expect(peak).toBe(3);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(adapter.active.size).toBe(0);
  });

  it('more slots do not add polling: an idle worker polls the same with 1 or 8 slots', async () => {
    // Side by side over the same window, so a loaded machine slows both alike instead of skewing one
    // fixed-length window against the other.
    const pollsWith = (concurrency: number) => {
      const adapter = new MockAdapter();
      const pop = vi.spyOn(adapter, 'popFrom');
      const worker = make(adapter, { concurrency, idleBackoffMax: 1 });
      worker.handle('ext.work', async () => 'x');
      return () => pop.mock.calls.length;
    };
    const one = pollsWith(1);
    const eight = pollsWith(8);
    await until(() => one() >= 20 && eight() >= 1);
    // One loop per worker whatever its slots: eight slots polling on their own would be ~8×.
    expect(eight()).toBeLessThan(one() * 2);
  });

  it('an idle task loop backs off; the results loop never does', async () => {
    const adapter = new MockAdapter();
    const pop = vi.spyOn(adapter, 'popFrom');
    // Backing off to 32 × 5ms = 160ms between idle task rounds, against 5ms for results: the ratio
    // stays far above 2 even when a loaded machine stretches every timer.
    const t = make(adapter, { idleBackoffMax: 32 });
    t.handle('ext.work', async () => 'x');
    t.onResult(async () => {});
    const callsOn = (queue: string) => pop.mock.calls.filter(([q]) => q === queue).length;
    // Counted, not timed: enough result rounds for the task loop to have reached its ceiling.
    await until(() => callsOn('durable:results') >= 80);
    const taskPolls = callsOn('durable:tasks:ext.work');
    const resultPolls = callsOn('durable:results');
    expect(resultPolls).toBeGreaterThan(taskPolls * 2);
  });

  it('a job found after a quiet spell resets the backoff', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter, { idleBackoffMax: 1 });
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    const worker = make(adapter, { idleBackoffMax: 4 });
    worker.handle('ext.work', async (input) => input);
    await sleep(100); // backed off to 4 × 5ms
    for (let i = 1; i <= 5; i += 1) await engine.dispatch(task(i));
    // A burst drains without sleeping between jobs once the first is found.
    await until(() => results.length === 5, 500);
  });

  it('a non-finite concurrency falls back to one slot instead of popping the backlog unbounded', async () => {
    const { peak } = await peakInFlight(Number.NaN, 4, 1);
    expect(peak).toBe(1);
  });

  it('close() waits for every in-flight slot and completes those jobs instead of re-queueing them', async () => {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    let started = 0;
    const worker = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: POLL,
      stalledCheckIntervalMs: 0,
      concurrency: 3,
    });
    worker.handle('ext.work', async (input) => {
      started += 1;
      await sleep(60);
      return input;
    });
    for (let i = 1; i <= 3; i += 1) await engine.dispatch(task(i));
    await until(() => started === 3);
    await worker.close();
    // Every slot finished inside the drain: results pushed, nothing left claimed or re-queued.
    await until(() => results.length === 3);
    expect(adapter.active.size).toBe(0);
    expect(adapter.pending.get('durable:tasks:ext.work') ?? []).toHaveLength(0);
  });
});

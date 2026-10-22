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

async function until(cond: () => boolean, budgetMs = 3000): Promise<void> {
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

  /** Run `jobs` slow steps through a worker with `concurrency` slots; report the peak in flight. */
  async function peakInFlight(concurrency: number | undefined, jobs: number) {
    const adapter = new MockAdapter();
    const engine = make(adapter);
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    let running = 0;
    let peak = 0;
    const worker = make(adapter, concurrency === undefined ? {} : { concurrency });
    worker.handle('ext.work', async (input) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(30);
      running -= 1;
      return input;
    });
    for (let i = 1; i <= jobs; i += 1) await engine.dispatch(task(i));
    await until(() => results.length === jobs);
    return { peak, results, adapter };
  }

  it('runs one job at a time by default', async () => {
    const { peak } = await peakInFlight(undefined, 4);
    expect(peak).toBe(1);
  });

  it('runs up to `concurrency` jobs of one step at once, and never more', async () => {
    const { peak, results, adapter } = await peakInFlight(3, 10);
    expect(peak).toBe(3);
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    expect(adapter.active.size).toBe(0);
  });

  it('more slots do not add polling: an idle worker polls the same with 1 or 8 slots', async () => {
    const pollsWith = async (concurrency: number) => {
      const adapter = new MockAdapter();
      const pop = vi.spyOn(adapter, 'popFrom');
      const worker = make(adapter, { concurrency, idleBackoffMax: 1 });
      worker.handle('ext.work', async () => 'x');
      await sleep(100);
      return pop.mock.calls.length;
    };
    const one = await pollsWith(1);
    const eight = await pollsWith(8);
    expect(eight).toBeLessThan(one * 2);
  });

  it('an idle task loop backs off; the results loop never does', async () => {
    const adapter = new MockAdapter();
    const pop = vi.spyOn(adapter, 'popFrom');
    const t = make(adapter, { idleBackoffMax: 8 });
    t.handle('ext.work', async () => 'x');
    t.onResult(async () => {});
    await sleep(200);
    const callsOn = (queue: string) => pop.mock.calls.filter(([q]) => q === queue).length;
    const taskPolls = callsOn('durable:tasks:ext.work');
    const resultPolls = callsOn('durable:results');
    // Base interval 5ms: ~40 polls in 200ms without backoff, ~5-8 with it capped at 8 intervals.
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

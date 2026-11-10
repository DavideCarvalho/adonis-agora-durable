import type { AcquiredJob } from '@adonisjs/queue/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteTask } from '../../../src/interfaces.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/**
 * The queue transport's poll loops across a stop: a pop already in flight when the loop (or the
 * transport) stops must not run the job it then gets. Each test parks the loop's next pop, stops,
 * pushes a job, then lets the pop go: the handler never runs, and the job is re-delivered (back on its
 * queue) for another consumer.
 */

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A mock adapter whose next pop of one queue can be parked until released. */
class GatedAdapter extends MockAdapter {
  #queue: string | undefined;
  parked = 0;
  #release!: () => void;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  async park(queue: string): Promise<void> {
    this.#queue = queue;
    await until(() => this.parked > 0);
    this.#queue = undefined;
  }
  release(): void {
    this.#release();
  }
  override async popFrom(queue: string): Promise<AcquiredJob | null> {
    if (queue === this.#queue) {
      this.parked += 1;
      await this.#gate;
    }
    return super.popFrom(queue);
  }
  /** Jobs waiting on `queue`: pending, or re-delivered and due. */
  waiting(queue: string): number {
    return (this.pending.get(queue)?.length ?? 0) + (this.delayed.get(queue)?.length ?? 0);
  }
}

const task: RemoteTask = {
  runId: 'r1',
  seq: 0,
  name: 'math',
  stepId: 'r1:0',
  group: 'math',
  input: 1,
  attempt: 1,
};

describe('queue transport stop', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function setup() {
    const adapter = new GatedAdapter();
    const make = () =>
      new QueueTransport({ adapter: () => adapter, prefix: 'app', pollIntervalMs: 5 });
    const consumer = make();
    const producer = make();
    cleanups.push(async () => {
      adapter.release();
      await consumer.close();
    });
    return { adapter, consumer, producer };
  }

  it('the task loop runs no job popped after close()', async () => {
    const { adapter, consumer, producer } = setup();
    let ran = 0;
    consumer.handle('math', async (input) => {
      ran += 1;
      return input;
    });
    await adapter.park('app:tasks:math');
    const closing = consumer.close();
    await producer.dispatch(task);
    adapter.release();
    await closing;
    await new Promise((r) => setTimeout(r, 100));
    expect(ran).toBe(0);
    expect(adapter.waiting('app:tasks:math')).toBe(1);
  });

  it('the result loop settles no result popped after close()', async () => {
    const { adapter, consumer } = setup();
    let settled = 0;
    consumer.onResult(async () => {
      settled += 1;
    });
    await adapter.park('app:results');
    const closing = consumer.close();
    await adapter.pushOn('app:results', {
      id: 'res-1',
      name: 'result',
      payload: JSON.stringify({
        runId: 'r1',
        seq: 0,
        stepId: 'r1:0',
        status: 'completed',
        output: 1,
      }),
      attempts: 0,
      createdAt: Date.now(),
    });
    adapter.release();
    await closing;
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(0);
    expect(adapter.waiting('app:results')).toBe(1);
  });

  it('a run-queue consumer takes no run popped after its own stop() resolved', async () => {
    const { adapter, consumer, producer } = setup();
    let runs = 0;
    const stop = consumer.onDispatchedRun(
      async () => {
        runs += 1;
      },
      { concurrency: 2 },
    );
    await adapter.park('app:runs');
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await producer.dispatchRuns([{ runId: 'q1' }]);
    adapter.release();
    await stopping;
    expect(stopped).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(runs).toBe(0);
    expect(adapter.waiting('app:runs')).toBe(1);
  });
});

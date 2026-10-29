import { describe, expect, it } from 'vitest';
import { currentStep } from '../../src/ambient-step.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepLogger } from '../../src/interfaces.js';
import { sanitizeQueueToken } from '../../src/tenant-group.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { DbTransport } from '../../src/transports/db.js';
import { EventEmitterTransport } from '../../src/transports/event-emitter.js';
import { QueueTransport } from '../../src/transports/queue.js';
import { MockAdapter } from '../../src/transports/queue-mock-adapter.js';
import { dbBackends } from '../support/backends.js';

/**
 * `log.signal`: shutdown waits for in-flight steps only for a bounded time, so a long step needs to
 * know the process is going away to stop between units of work. Every transport aborts it when its
 * `close()` starts; the engine aborts it for local steps when it begins draining. (The bullmq side,
 * with its hand-back, is in `transports/bullmq/bullmq-close-handback.spec.ts`.)
 */

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const task = (name: string): RemoteTask => ({
  runId: 'r1',
  seq: 1,
  name,
  stepId: 'r1:1',
  group: sanitizeQueueToken(name),
  input: {},
  attempt: 1,
});

/** A step that works until told to stop; records the signals it saw (argument and ambient). */
function stoppableStep() {
  const seen: { arg?: AbortSignal; ambient?: AbortSignal | undefined; stopped: boolean } = {
    stopped: false,
  };
  const handler = async (_input: unknown, log: StepLogger) => {
    seen.arg = log.signal;
    seen.ambient = currentStep()?.signal;
    await until(() => log.signal.aborted, 60_000);
    seen.stopped = true;
    return 'stopped early';
  };
  return { seen, handler };
}

describe('log.signal aborts when the worker shuts down', () => {
  it('queue transport: on close()', async () => {
    const transport = new QueueTransport({
      adapter: () => new MockAdapter(),
      pollIntervalMs: 5,
      stalledCheckIntervalMs: 0,
      closeTimeoutMs: 2_000,
    });
    const { seen, handler } = stoppableStep();
    transport.handle('ext.crawl', handler);
    await transport.dispatch(task('ext.crawl'));
    await until(() => seen.arg !== undefined);
    expect(seen.arg?.aborted).toBe(false);
    expect(seen.ambient).toBe(seen.arg);

    const t0 = Date.now();
    await transport.close();
    expect(seen.stopped).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('event-emitter transport: on close()', async () => {
    const transport = new EventEmitterTransport();
    const { seen, handler } = stoppableStep();
    transport.handle('ext.crawl', handler);
    transport.onResult(async () => undefined);
    const dispatched = transport.dispatch(task('ext.crawl'));
    await until(() => seen.arg !== undefined);
    expect(seen.arg?.aborted).toBe(false);

    await transport.close();
    await dispatched;
    await until(() => seen.stopped);
  });

  it('engine: a local step sees it when the engine begins draining', async () => {
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new EventEmitterTransport(),
    });
    const { seen, handler } = stoppableStep();
    engine.register('crawl', '1', async (ctx) =>
      ctx.localStep('crawl.local', (log) => handler({}, log)),
    );

    await engine.start('crawl', {}, 'run-local');
    await until(() => seen.arg !== undefined);
    expect(seen.arg?.aborted).toBe(false);

    await engine.drain(2_000);
    expect(seen.stopped).toBe(true);
  });
});

describe.each(dbBackends())('on $name', ({ makeTransportDb }) => {
  it('db transport: log.signal aborts on close()', async () => {
    const db = await makeTransportDb();
    try {
      const transport = new DbTransport({ db, pollIntervalMs: 5, closeTimeoutMs: 2_000 });
      const { seen, handler } = stoppableStep();
      transport.handle('ext.crawl', handler);
      await transport.dispatch(task('ext.crawl'));
      await until(() => seen.arg !== undefined);
      expect(seen.arg?.aborted).toBe(false);

      await transport.close();
      expect(seen.stopped).toBe(true);
    } finally {
      await db.manager.closeAll();
    }
  });
});

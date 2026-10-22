import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowDecision } from '../../../src/interfaces.js';
import { BullMQTransport } from '../../../src/transports/bullmq/bullmq-transport.js';
import type {
  BullMQDeps,
  JobLike,
  ProcessFn,
  QueueLike,
  RedisLike,
  WorkerLike,
} from '../../../src/transports/bullmq/deps.js';
import { DbTransport } from '../../../src/transports/db.js';
import { makeTransportDb } from '../../../src/transports/db-helpers.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/**
 * Every `onDecision` handler sees every decision. One handler failing must not cut the others short:
 * with `Promise.all` the job was failed (and redelivered) the moment the first handler rejected,
 * while the others were still running, so the redelivery ran them a second time CONCURRENTLY with
 * the first, and only the first failure was ever reported. Now every handler settles first, each
 * failure is reported, and only then is the decision redelivered (safe: the engine applies a
 * decision at most once, fenced by its task id).
 */

const decision: WorkflowDecision = {
  taskId: 't1',
  runId: 'r1',
  status: 'continue',
  commands: [],
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, budgetMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await delay(2);
  }
}

/** Two failing handlers and one slow healthy one, instrumented for overlap. */
function handlers() {
  const state = { slowRuns: 0, slowActive: 0, maxSlowActive: 0, slowDone: 0 };
  const failA = async () => {
    throw new Error('handler A down');
  };
  const failB = async () => {
    throw new Error('handler B down');
  };
  const slow = async () => {
    state.slowRuns += 1;
    state.slowActive += 1;
    state.maxSlowActive = Math.max(state.maxSlowActive, state.slowActive);
    await delay(60);
    state.slowActive -= 1;
    state.slowDone += 1;
  };
  return { state, all: [failA, failB, slow] };
}

const messages = (errors: unknown[]) => errors.map((e) => (e as Error).message);

describe('onDecision — per-handler failure isolation', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  it('queue transport', async () => {
    const adapter = new MockAdapter();
    const errors: unknown[] = [];
    const engineSide = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: 5,
      stalledCheckIntervalMs: 0,
      onError: (e) => errors.push(e),
    });
    const worker = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: 5,
      stalledCheckIntervalMs: 0,
    });
    closers.push(
      () => engineSide.close(),
      () => worker.close(),
    );
    const { state, all } = handlers();
    for (const h of all) engineSide.onDecision(h);
    worker.handleWorkflow('wf', async () => decision);
    await worker.dispatchWorkflowTask({
      taskId: 't1',
      runId: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      input: {},
      history: [],
      group: 'wf',
      attempt: 1,
    });
    await until(() => state.slowDone >= 2); // first delivery + one redelivery
    expect(state.maxSlowActive).toBe(1);
    // Both failures of the first delivery are reported, not only the first.
    const first = messages(errors).slice(0, 2).sort();
    expect(first).toEqual(['handler A down', 'handler B down']);
  });

  it('db transport', async () => {
    const db = await makeTransportDb();
    closers.push(() => db.manager.closeAll());
    const errors: unknown[] = [];
    const t = new DbTransport({
      db,
      pollIntervalMs: 5,
      instanceId: 'engine',
      onError: (e) => errors.push(e),
    });
    closers.unshift(() => t.close());
    const { state, all } = handlers();
    for (const h of all) t.onDecision(h);
    const worker = new DbTransport({ db, pollIntervalMs: 5, instanceId: 'worker' });
    closers.unshift(() => worker.close());
    worker.handleWorkflow('wf', async () => decision);
    await t.dispatchWorkflowTask({
      taskId: 't1',
      runId: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      input: {},
      history: [],
      group: 'wf',
      attempt: 1,
    });
    await until(() => state.slowDone >= 1);
    await delay(150);
    expect(state.maxSlowActive).toBe(1);
    const reported = messages(errors);
    expect(reported).toContain('handler A down');
    expect(reported).toContain('handler B down');
  });

  it('bullmq transport', async () => {
    const workers: Array<{ name: string; process: ProcessFn }> = [];
    const deps: BullMQDeps = {
      makeQueue: (): QueueLike => ({
        add: async () => undefined,
        getJobCounts: async () => ({}),
        close: async () => undefined,
      }),
      makeWorker: (name: string, process: ProcessFn): WorkerLike => {
        workers.push({ name, process });
        return { on: () => undefined, close: async () => undefined } as unknown as WorkerLike;
      },
      makeRedis: (): RedisLike => ({
        publish: async () => 1,
        subscribe: async () => 1,
        on() {
          return this;
        },
        set: async () => 'OK',
        scan: async () => ['0', []],
        get: async () => null,
        disconnect() {},
      }),
    };
    const errors: unknown[] = [];
    const t = new BullMQTransport({ deps, onError: (e) => errors.push(e), pingIntervalMs: false });
    closers.push(() => t.close());
    const { state, all } = handlers();
    for (const h of all) t.onDecision(h);
    const decisions = workers.find((w) => w.name.includes('decisions'));
    if (!decisions) throw new Error('no decisions worker');
    // BullMQ fails the job (and retries it) when the processor rejects: it must reject only once
    // every handler has settled, after each failure was reported.
    const outcome = await decisions.process({ data: decision } as unknown as JobLike).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(state.slowDone).toBe(1); // the slow handler finished before the job was failed
    expect(['handler A down', 'handler B down']).toContain(outcome);
    expect(messages(errors)).toHaveLength(1); // the other failure; BullMQ reports the rethrown one
  });
});

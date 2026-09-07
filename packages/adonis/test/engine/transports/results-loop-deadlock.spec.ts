import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/**
 * The results-consumer loop is SERIAL per queue (`QueueTransport.#reallyStartLoop`: `await
 * onJob(job)` then `completeJob`). The engine's `onResult` handler used to `await
 * completeRemoteResult(result)`, which `await`s the resumed turn — and that turn can itself await
 * the NEXT remote step in-memory (when it has `timeoutMs`), whose result arrives on the SAME serial
 * loop. One result then wedged the entire loop behind it: subsequent results piled up un-acked,
 * `completeJob` never ran, and the awaited next-step result was itself stuck behind in the queue —
 * a self-deadlock broken only when the step's liveness timer fired (minutes) or the run failed.
 *
 * The contract: consuming a result settles its checkpoint and acks the job PROMPTLY; the resume it
 * triggers must not hold the loop. So the first result's `completeJob` happens first, the second
 * result is still consumed + checkpointed within a short bound, and the run finishes — instead of
 * wedging behind the first result until the second step's `timeoutMs` fires.
 */

/** Poll the store until `runId` reaches a terminal state (results travel over a poll loop). */
async function settle(store: InMemoryStateStore, runId: string, budgetMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const run = await store.getRun(runId);
    if (run && run.status !== 'pending' && run.status !== 'running' && run.status !== 'suspended') {
      return run;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  const run = await store.getRun(runId);
  const cps = await store.listCheckpoints(runId);
  throw new Error(
    `run ${runId} did not settle: status=${run?.status} checkpoints=${JSON.stringify(
      cps.map((c) => `${c.seq}:${c.name}=${c.status}`),
    )}`,
  );
}

describe('QueueTransport results loop — a consumed result never wedges the loop', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c().catch(() => undefined)));
  });

  it('acks the first result promptly even when its resume suspends on the next remote step', async () => {
    const adapter = new MockAdapter();
    const store = new InMemoryStateStore();
    const track = (t: QueueTransport): QueueTransport => {
      cleanups.push(() => t.close());
      return t;
    };
    const engineTransport = track(
      new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }),
    );
    const workerTransport = track(
      new QueueTransport({ adapter: () => adapter, pollIntervalMs: 5 }),
    );

    // Both steps served promptly: the worker answers in milliseconds, so any delay in finishing
    // the run is the consumer loop wedging — not a slow worker.
    workerTransport.handle('chain.first', async () => ({ v: 21 }));
    workerTransport.handle('chain.second', async (input) => {
      const { n } = input as { n: number };
      return { v: n * 2 };
    });

    const engine = new WorkflowEngine({ store, transport: engineTransport });
    engine.register('chain', '1', async (ctx) => {
      // The first step suspends DURABLY (no `timeoutMs`): its result resumes the run via the
      // results loop. The second step awaits IN-MEMORY (`timeoutMs`): the resumed turn suspends on
      // it, and its result arrives on that SAME serial results loop, behind the first result's job.
      const a = await ctx.step<{ v: number }>('chain.first', { n: 1 });
      const b = await ctx.step<{ v: number }>('chain.second', { n: a.v }, { timeoutMs: 30_000 });
      return b.v;
    });

    await engine.start('chain', {}, 'run-wedge');

    // 2s≪30s: pre-fix this times out — the run stays `suspended`, the second checkpoint stays
    // `pending`, and the second result sits un-acked behind the first result's wedged job until the
    // 30s liveness timer fires. Post-fix the whole chain finishes in milliseconds.
    const run = await settle(store, 'run-wedge', 2000);
    expect(run.status).toBe('completed');
    expect(run.output).toBe(42);

    // The second result was consumed and checkpointed (not stranded): consuming the second
    // result strictly precedes the run's completion — so completion/output/checkpoint remain
    // causally guaranteed here, not timing. The job ack (`completeJob`) runs after the `onResult`
    // handler returns while the run completes via the turn continuation racing ahead on microtasks,
    // so the drain is only eventually-consistent: bounded wait, not an immediate assertion.
    // (Heartbeats ride their own queue/loop and task acks on
    // the worker side are unordered relative to completion, so neither is asserted.)
    expect((await store.getCheckpoint('run-wedge', 1))?.status).toBe('completed');
    let leftover = adapter.pending.get('durable:results') ?? [];
    const drainStart = Date.now();
    while (leftover.length > 0 && Date.now() - drainStart < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      leftover = adapter.pending.get('durable:results') ?? [];
    }
    expect(
      leftover,
      `results queue did not drain: leftover=${JSON.stringify(leftover)}`,
    ).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  Heartbeat,
  HistoryEvent,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
} from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * REGRESSION: a cross-SDK `ctx.gather_calls` fan-out whose worker process is KILLED mid-step (an OOM
 * kill, exit 137 — a pod's memory ceiling, not a bug in anyone's code) must not orphan the step forever.
 *
 * A polyglot workflow's turn declares its fan-out as `call` commands, and `applyCommands` persists a
 * `pending` checkpoint + dispatches each one. On every LATER turn the worker's replay RE-EMITS the calls
 * it is still waiting on (the fan-out is only partially settled), and `applyCommands` skips a command
 * whose checkpoint already exists — the guard that stops a partial resume from double-dispatching its
 * still-in-flight siblings (see `gather-calls.spec.ts`).
 *
 * That guard had no notion of a LOST job. A dead worker's job is not always recoverable at the transport
 * layer: the `bullmq` transport's `worker.on('failed')` bridge only exists inside a JS consumer (a
 * first-class Python fleet — see `docs/python.mdx` — has none), and the `queue` transport's reclaim sweep
 * gives up after `maxStalledCount`, or never runs at all on an adapter without `recoverStalledJobs`.
 * Nothing then publishes a `StepResult`, yet the checkpoint still reads `pending` — "out for delivery" —
 * so every later turn skipped it: the run woke on the `reconcileMs` sweep, dispatched a turn, had the
 * calls re-emitted, skipped them, and slept. Forever.
 *
 * `attempts` never leaving 1 and the checkpoint's `wakeAt` staying NULL were the tells: `callRemote`
 * (the `ctx.step` path) stamps a re-dispatch deadline on `wakeAt` the first time it sees a pending step
 * and honours `remoteRedispatchMs`; the polyglot `call` path did neither — so the self-heal
 * `docs/reliability/failure-modes.mdx` documents as acting "on the checkpoint regardless of which
 * transport lost the job" simply did not exist for a fan-out.
 *
 * `reconcileMs: 0` disables the orphan sweep so these tests assert the re-drive itself, not the safety
 * net that would eventually wake the run anyway (and still find nothing to do).
 */

const FAN = 3;
const LOST_SEQ = 1;

/** A transport whose step results the test drives, and which can LOSE a dispatched job — the OOM kill:
 *  the task never reaches a handler, so no result will ever come back. */
class LossyTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  /** Step names whose FIRST dispatch is swallowed (the job that died with the worker). */
  readonly loseFirstDispatchOf = new Set<string>();
  /** Step names whose EVERY dispatch is swallowed — a step nothing will ever deliver. */
  readonly loseEveryDispatchOf = new Set<string>();
  /** How many times each step name actually RAN (a re-drive must not double-run a settled sibling). */
  readonly ran = new Map<string, number>();
  heartbeatHandler?: (beat: Heartbeat) => Promise<void>;
  private resultHandler?: (result: StepResult) => Promise<void>;

  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
    if (this.loseEveryDispatchOf.has(task.name)) return;
    if (this.loseFirstDispatchOf.has(task.name) && (task.attempt ?? 1) === 1) return;
    this.ran.set(task.name, (this.ran.get(task.name) ?? 0) + 1);
    const result: StepResult = {
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: { r: task.seq },
    };
    // Asynchronously, like a real broker: the run suspends right after dispatch, so the result must
    // land after that unwinds.
    setImmediate(() => void this.resultHandler?.(result));
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.heartbeatHandler = handler;
  }

  dispatchesOf(name: string): number {
    return this.dispatched.filter((task) => task.name === name).length;
  }
}

/**
 * A hand-scripted stand-in for a Python `@workflow` whose replay emits a `ctx.gather_calls([...])`
 * fan-out and re-emits whatever has not settled yet — `gather_calls`' real behaviour on a partial
 * resume. A failed call raises inside the gather, so the replay ends the run: what the real SDK does
 * when the engine gives up on a step it can no longer deliver.
 */
function fanCallExecutor(): WorkflowExecutor {
  return {
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      const bySeq = new Map(history.map((event) => [event.seq, event]));
      const base = { taskId: 't', runId: run.id } as const;
      const failed = history.find((event) => event.error);
      if (failed?.error) return { ...base, status: 'failed', commands: [], error: failed.error };
      const missing = Array.from({ length: FAN }, (_, seq) => seq).filter((seq) => !bySeq.has(seq));
      if (missing.length === 0) {
        return {
          ...base,
          status: 'completed',
          commands: [],
          output: { outputs: missing.length },
        };
      }
      return {
        ...base,
        status: 'continue',
        commands: missing.map((seq) => ({
          kind: 'call' as const,
          seq,
          name: `leaf_${seq}`,
          group: 'ext',
          input: { i: seq },
          parallelGroup: 'gather:0',
        })),
      };
    },
  };
}

interface Harness {
  engine: WorkflowEngine;
  store: InMemoryStateStore;
  transport: LossyTransport;
  now: () => number;
  advance: (ms: number) => void;
  /** One timer-poller tick: what `durable:work` does on its interval. */
  tick: () => Promise<void>;
  /** Start the run and let the first turn's dispatches settle. */
  start: () => Promise<void>;
}

function harness(
  opts: { remoteRedispatchMs?: number; remoteRedispatchMax?: number } = {},
): Harness {
  let now = 1_000_000;
  const store = new InMemoryStateStore();
  const transport = new LossyTransport();
  const engine = new WorkflowEngine({
    store,
    transport,
    clock: () => now,
    reconcileMs: 0,
    ...opts,
  });
  engine.registerRemote('fan', '1', { group: 'py-workflows', executor: fanCallExecutor() });
  return {
    engine,
    store,
    transport,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    tick: async () => {
      await engine.resumeDueTimers(now);
      await drain();
    },
    start: async () => {
      await engine.start('fan', {}, 'fan1');
      await drain();
    },
  };
}

/** Let the transport's `setImmediate` result hops and the engine's deferred resumes settle. */
async function drain(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function checkpointAt(store: InMemoryStateStore, seq: number) {
  return store.listCheckpoints('fan1').then((cps) => cps.find((cp) => cp.seq === seq));
}

describe('WorkflowEngine — a gather_calls step whose worker died is re-driven', () => {
  it('without remoteRedispatchMs the lost step stays pending (attempts=1, no lease) and the run never completes', async () => {
    const h = harness(); // the shipped default: re-suspend, never re-dispatch
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);

    await h.start();

    // Every turn re-emits the lost call, and every turn skips it: the run is parked forever.
    for (let i = 0; i < 5; i += 1) {
      h.advance(600_000);
      await h.tick();
    }

    const run = await h.store.getRun('fan1');
    const lost = await checkpointAt(h.store, LOST_SEQ);
    expect(run?.status).toBe('suspended');
    expect(lost?.status).toBe('pending');
    expect(lost?.attempts).toBe(1);
    expect(lost?.wakeAt).toBeUndefined();
    expect(h.transport.dispatchesOf(`leaf_${LOST_SEQ}`)).toBe(1); // never re-dispatched
  });

  it('leases the dispatched call and re-drives it once the lease lapses, and the run completes', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);

    await h.start();

    // The dispatch stamped a lease on the pending checkpoint, and the run suspended ON it — so the
    // timer poller (not the reconcile net, disabled here) is what brings the run back.
    const leased = await checkpointAt(h.store, LOST_SEQ);
    expect(leased?.wakeAt).toBe(h.now() + 60_000);
    expect((await h.store.getRun('fan1'))?.wakeAt).toBe(h.now() + 60_000);

    // Before the lease lapses: nothing is re-dispatched.
    h.advance(30_000);
    await h.tick();
    expect(h.transport.dispatchesOf(`leaf_${LOST_SEQ}`)).toBe(1);

    // Past it: re-dispatched once, the result lands, the run finishes.
    h.advance(31_000);
    await h.tick();
    await drain();

    expect(h.transport.dispatchesOf(`leaf_${LOST_SEQ}`)).toBe(2);
    expect((await h.store.getRun('fan1'))?.status).toBe('completed');
  });

  it('re-drives EVERY call the dead worker was holding, in one turn', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    for (let seq = 0; seq < FAN; seq += 1) h.transport.loseFirstDispatchOf.add(`leaf_${seq}`);

    await h.start();
    expect(h.transport.dispatched).toHaveLength(FAN); // dispatched, all lost with the worker

    h.advance(61_000);
    await h.tick();
    await drain();

    for (let seq = 0; seq < FAN; seq += 1) {
      expect(h.transport.dispatchesOf(`leaf_${seq}`)).toBe(2);
    }
    expect((await h.store.getRun('fan1'))?.status).toBe('completed');
  });

  it('never re-runs the siblings that completed before the crash (the settled checkpoint wins)', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);

    await h.start();
    h.advance(61_000);
    await h.tick();
    await drain();

    expect((await h.store.getRun('fan1'))?.status).toBe('completed');
    for (let seq = 0; seq < FAN; seq += 1) expect(h.transport.ran.get(`leaf_${seq}`)).toBe(1);
  });

  it('marks the re-drive on the step so it reads differently from a failure retry', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`);
    const started: Array<{ seq?: number | undefined; redispatched?: boolean | undefined }> = [];
    h.engine.subscribe((event) => {
      if (event.type === 'step.started') {
        started.push({ seq: event.seq, redispatched: event.redispatched });
      }
    });

    await h.start();
    expect((await checkpointAt(h.store, LOST_SEQ))?.events).toBeUndefined();

    h.advance(61_000);
    await h.tick();
    await drain();

    expect(started.filter((event) => event.redispatched)).toEqual([
      { seq: LOST_SEQ, redispatched: true },
    ]);
    const cp = await checkpointAt(h.store, LOST_SEQ);
    expect(cp?.events?.map((event) => event.name)).toEqual(['step.redispatched']);
    expect(cp?.events?.[0]?.level).toBe('warn');
    expect(cp?.events?.[0]?.message).toMatch(/lost/i);
  });

  it('is bounded: past remoteRedispatchMax the step is failed instead of re-dispatched forever', async () => {
    const h = harness({ remoteRedispatchMs: 60_000, remoteRedispatchMax: 2 });
    h.transport.loseEveryDispatchOf.add(`leaf_${LOST_SEQ}`);

    await h.start();
    for (let i = 0; i < 8; i += 1) {
      h.advance(61_000);
      await h.tick();
      await drain();
    }

    const run = await h.store.getRun('fan1');
    expect(h.transport.dispatchesOf(`leaf_${LOST_SEQ}`)).toBeLessThanOrEqual(3); // 1 + max 2 re-drives
    expect(run?.status).toBe('failed');
    expect(JSON.stringify(run?.error)).toMatch(/lost/i);
    const cp = await checkpointAt(h.store, LOST_SEQ);
    expect(cp?.status).toBe('failed');
    expect(cp?.error?.code).toBe('remote_step_lost');
    expect(cp?.events?.map((event) => event.name)).toContain('step.lost');
  });

  it('does NOT re-drive a step a live worker is still holding — its heartbeat renews the lease', async () => {
    const h = harness({ remoteRedispatchMs: 60_000 });
    h.transport.loseFirstDispatchOf.add(`leaf_${LOST_SEQ}`); // no result — but the worker is alive

    await h.start();
    const cp = await checkpointAt(h.store, LOST_SEQ);
    if (!cp?.stepId) throw new Error('expected a dispatched checkpoint');

    // A worker beating for this step keeps the lease alive across several lapsed windows.
    for (let i = 0; i < 4; i += 1) {
      h.advance(45_000);
      await h.transport.heartbeatHandler?.({
        runId: 'fan1',
        seq: LOST_SEQ,
        stepId: cp.stepId,
        group: `leaf_${LOST_SEQ}`,
      });
      await h.tick();
      expect(h.transport.dispatchesOf(`leaf_${LOST_SEQ}`)).toBe(1);
    }

    // The beats stop (the worker dies) — now the lease lapses and the step is re-driven.
    h.advance(61_000);
    await h.tick();
    await drain();
    expect(h.transport.dispatchesOf(`leaf_${LOST_SEQ}`)).toBe(2);
  });
});

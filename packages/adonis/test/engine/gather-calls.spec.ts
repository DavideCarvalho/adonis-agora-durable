import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  HistoryEvent,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
} from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/** Poll until the run reaches a terminal state (a remote fan-out resumes the run once per landed
 *  result, so it only completes after every call settles). */
async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 400; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

/** Resolve after `ticks` macrotasks so the three calls' results land at staggered times — forcing a
 *  PARTIAL resume (some calls still pending) on which the executor re-emits the outstanding calls. */
function resolveAfter(ticks: number, value: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let n = ticks;
    const step = () => (n-- <= 0 ? resolve(value) : setTimeout(step, 1));
    step();
  });
}

/**
 * A hand-scripted stand-in for a Python `@workflow` whose replay emits a cross-SDK
 * `ctx.gather_calls([...])` fan-out: three `call` commands carrying the SAME `parallelGroup`. The body
 * re-emits any call still absent from history on every (partial) resume — exactly what `gather_calls`
 * does — so the engine's `call` idempotency guard is exercised: a re-emitted pending call must NOT
 * dispatch twice. Completes once all three results are in history, in input order.
 */
function fanCallExecutor(): WorkflowExecutor {
  const names = ['call_a', 'call_b', 'call_c'];
  return {
    async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
      const bySeq = new Map(history.map((e) => [e.seq, e]));
      const base = { taskId: 't', runId: run.id } as const;
      const commands = names
        .map((name, seq) => ({ name, seq }))
        .filter(({ seq }) => !bySeq.has(seq))
        .map(({ name, seq }) => ({
          kind: 'call' as const,
          seq,
          name,
          group: 'ext',
          input: { i: seq },
          parallelGroup: 'gather:0',
        }));
      if (commands.length > 0) return { ...base, status: 'continue', commands };
      // All three resolved. If any carried an error, fail the run with it (mirrors GatherFailed).
      const failed = names.map((_, seq) => bySeq.get(seq)).find((e) => e?.error);
      if (failed?.error) return { ...base, status: 'failed', commands: [], error: failed.error };
      const outputs = names.map((_, seq) => bySeq.get(seq)?.output);
      return { ...base, status: 'completed', commands: [], output: { outputs } };
    },
  };
}

describe('WorkflowEngine — cross-SDK remote fan-out (gather_calls)', () => {
  it('dispatches each gathered call EXACTLY ONCE despite re-emits, tags the fan, resolves in order', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const dispatchCounts: { call_a: number; call_b: number; call_c: number } = {
      call_a: 0,
      call_b: 0,
      call_c: 0,
    };
    // Stagger the results (a fast, b medium, c slow) so the run PARTIALLY resumes with b/c still
    // pending — and the executor re-emits them. Count every handler invocation: the engine must not
    // re-dispatch an already-in-flight call, so each count stays at 1.
    transport.handle('call_a', async () => {
      dispatchCounts.call_a += 1;
      return resolveAfter(1, { r: 'a' });
    });
    transport.handle('call_b', async () => {
      dispatchCounts.call_b += 1;
      return resolveAfter(6, { r: 'b' });
    });
    transport.handle('call_c', async () => {
      dispatchCounts.call_c += 1;
      return resolveAfter(12, { r: 'c' });
    });

    const engine = new WorkflowEngine({ store, transport });
    engine.registerRemote('fan', '1', { group: 'py-workflows', executor: fanCallExecutor() });

    await startRun(engine, 'fan', {}, 'fan1');
    const run = await settle(store, 'fan1');
    expect(run.status).toBe('completed');
    // Outputs aggregated in input order.
    expect(run.output).toEqual({ outputs: [{ r: 'a' }, { r: 'b' }, { r: 'c' }] });

    // Each remote call was dispatched to its worker EXACTLY ONCE (idempotent re-emit).
    expect(dispatchCounts).toEqual({ call_a: 1, call_b: 1, call_c: 1 });

    // Every call checkpoint is a completed remote step carrying the shared fan group.
    const cps = await store.listCheckpoints('fan1');
    for (let seq = 0; seq < 3; seq += 1) {
      const cp = cps.find((c) => c.seq === seq);
      expect(cp?.kind).toBe('remote');
      expect(cp?.status).toBe('completed');
      expect(cp?.parallelGroup).toBe('gather:0');
    }
    // Exactly three call checkpoints — no duplicate seqs from the re-emits.
    expect(cps.filter((c) => c.kind === 'remote')).toHaveLength(3);
  });

  it('skips dispatch when a turn re-emits already-checkpointed (terminal) calls', async () => {
    // The guard must hold for an ALREADY-COMPLETED checkpoint too, not just a pending one: a turn that
    // re-emits a `call` whose result is already in history must NOT re-dispatch the worker or clobber
    // the recorded result. Drive it: turn 1 emits two calls (they resolve fast), turn 2 re-emits the
    // SAME two completed calls (the engine must skip both), then a final turn completes.
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const dispatchCounts: { call_a: number; call_b: number } = { call_a: 0, call_b: 0 };
    transport.handle('call_a', () => {
      dispatchCounts.call_a += 1;
      return { r: 'a' };
    });
    transport.handle('call_b', () => {
      dispatchCounts.call_b += 1;
      return { r: 'b' };
    });

    const engine = new WorkflowEngine({ store, transport });
    let reEmitted = false;
    const names = ['call_a', 'call_b'];
    const reemit: WorkflowExecutor = {
      async advance(run: WorkflowRun, history: HistoryEvent[]): Promise<WorkflowDecision> {
        const bySeq = new Map(history.map((e) => [e.seq, e]));
        const base = { taskId: 't', runId: run.id } as const;
        const emitAll = () =>
          names.map((name, seq) => ({
            kind: 'call' as const,
            seq,
            name,
            group: 'ext',
            input: { seq },
            parallelGroup: 'gather:0',
          }));
        // Turn 1: nothing in history → dispatch the fan.
        if (!bySeq.has(0) && !bySeq.has(1))
          return { ...base, status: 'continue', commands: emitAll() };
        // Turn 2: both already completed — re-emit them ONCE to exercise the terminal-skip guard.
        if (!reEmitted) {
          reEmitted = true;
          return { ...base, status: 'continue', commands: emitAll() };
        }
        // Final turn: aggregate in order and complete.
        return {
          ...base,
          status: 'completed',
          commands: [],
          output: { outputs: names.map((_, seq) => bySeq.get(seq)?.output) },
        };
      },
    };
    engine.registerRemote('reemit', '1', { group: 'py-workflows', executor: reemit });

    await startRun(engine, 'reemit', {}, 'reemit1');
    // Turn 2 (the re-emit) dispatches nothing, so it parks with no result to auto-resume it — drive the
    // final turn by hand, as a timer/poller would.
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      if ((await store.getRun('reemit1'))?.status === 'suspended') break;
    }
    await engine.resume('reemit1').catch(() => undefined);
    const run = await settle(store, 'reemit1');
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ outputs: [{ r: 'a' }, { r: 'b' }] });

    // Each call dispatched EXACTLY ONCE despite the re-emit of its completed checkpoint.
    expect(dispatchCounts).toEqual({ call_a: 1, call_b: 1 });

    const cps = await store.listCheckpoints('reemit1');
    expect(cps.filter((c) => c.kind === 'remote')).toHaveLength(2);
    for (let seq = 0; seq < 2; seq += 1) {
      const cp = cps.find((c) => c.seq === seq);
      expect(cp?.status).toBe('completed');
      expect(cp?.parallelGroup).toBe('gather:0');
    }
  });

  it('fails the run with the aggregate error when a gathered call fails', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('call_a', async () => resolveAfter(1, { r: 'a' }));
    transport.handle('call_b', async () => {
      throw new Error('b boom');
    });
    transport.handle('call_c', async () => resolveAfter(2, { r: 'c' }));

    const engine = new WorkflowEngine({ store, transport });
    engine.registerRemote('fan', '1', { group: 'py-workflows', executor: fanCallExecutor() });

    await startRun(engine, 'fan', {}, 'fanfail1');
    const run = await settle(store, 'fanfail1');
    expect(run.status).toBe('failed');
    expect(run.error?.message).toContain('b boom');
  });
});

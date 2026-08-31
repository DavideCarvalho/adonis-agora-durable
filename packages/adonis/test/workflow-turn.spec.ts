import { describe, expect, it } from 'vitest';
import type { WorkflowStepEvent, WorkflowTask } from '../src/interfaces.js';
import { isWorkflowTask, runWorkflowTurn, type WorkflowBody } from '../src/workflow-turn.js';

/** Build a workflow task with sensible defaults; override `history`/`input`/etc per turn. */
function task(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    workflow: 'checkout',
    workflowVersion: '1',
    input: undefined,
    history: [],
    group: 'checkout@acme',
    attempt: 1,
    ...overrides,
  };
}

const bodies = (map: Record<string, WorkflowBody>) => new Map(Object.entries(map));

describe('runWorkflowTurn — deterministic replay → decision (the shared pure turn body)', () => {
  it('dispatches a step on the first turn (continue) and completes on the second (replay), the core loop', async () => {
    // The workflow: dispatch `charge`, then complete with its result. Run ENTIRELY through the turn body
    // across two turns — the exact decision SEQUENCE the engine (or a store-less worker) applies.
    const checkout: WorkflowBody = (ctx, input) => {
      const paid = ctx.step('charge', { amount: (input as { amount: number }).amount });
      return { ok: true, paid };
    };

    // Turn 1 — empty history: the `charge` call is unresolved → emit a `call` command and suspend.
    const t1 = await runWorkflowTurn(bodies({ checkout }), task({ input: { amount: 200 } }), {
      partition: 'acme',
    });
    expect(t1.status).toBe('continue');
    expect(t1.commands).toEqual([
      { kind: 'call', seq: 0, name: 'charge', group: 'acme', input: { amount: 200 } },
    ]);
    expect(t1.output).toBeUndefined();

    // Turn 2 — history now carries the resolved call: replay returns its output → the body completes.
    // MUTATION ANCHOR: this is the replay. Break `#replay` (always report not-found) and this turn
    // re-dispatches `charge` (status 'continue') instead of completing → the assertions below go red.
    const t2 = await runWorkflowTurn(
      bodies({ checkout }),
      task({
        taskId: 'task-2',
        input: { amount: 200 },
        history: [{ seq: 0, kind: 'call', name: 'charge', output: { ref: 'ch_1' } }],
      }),
      { partition: 'acme' },
    );
    expect(t2.status).toBe('completed');
    expect(t2.commands).toEqual([]); // nothing NEW this turn — the step replayed as `found`
    expect(t2.output).toEqual({ ok: true, paid: { ref: 'ch_1' } });
    expect(t2.taskId).toBe('task-2');
    expect(t2.runId).toBe('run-1');
  });

  it('a step call inherits the workflow partition, or takes an explicit group', async () => {
    const wf: WorkflowBody = (ctx) => {
      ctx.step('a'); // inherits partition
      return null;
    };
    const inherited = await runWorkflowTurn(bodies({ checkout: wf }), task(), {
      partition: 'acme',
    });
    expect(inherited.commands[0]).toMatchObject({ kind: 'call', name: 'a', group: 'acme' });

    const explicit: WorkflowBody = (ctx) => {
      ctx.step('a', { x: 1 }, { group: 'other' });
      return null;
    };
    const pinned = await runWorkflowTurn(bodies({ checkout: explicit }), task(), {
      partition: 'acme',
    });
    expect(pinned.commands[0]).toMatchObject({ group: 'other' });
  });

  it('completes in a single turn when the body never blocks', async () => {
    const wf: WorkflowBody = (_ctx, input) => ({ doubled: (input as number) * 2 });
    const d = await runWorkflowTurn(bodies({ checkout: wf }), task({ input: 21 }));
    expect(d.status).toBe('completed');
    expect(d.output).toEqual({ doubled: 42 });
  });

  it('suspends on ctx.sleep with a sleep command, and replays past an elapsed timer', async () => {
    const wf: WorkflowBody = (ctx) => {
      ctx.sleep(5_000);
      return 'awake';
    };
    const t1 = await runWorkflowTurn(bodies({ checkout: wf }), task());
    expect(t1.status).toBe('continue');
    expect(t1.commands).toEqual([{ kind: 'sleep', seq: 0, ms: 5_000 }]);

    const t2 = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({ history: [{ seq: 0, kind: 'timer' }] }),
    );
    expect(t2.status).toBe('completed');
    expect(t2.output).toBe('awake');
  });

  it('suspends on ctx.waitSignal, and resolves from a delivered pendingSignal OR from history', async () => {
    const wf: WorkflowBody = (ctx) => ({ approval: ctx.waitSignal('approve') });

    const parked = await runWorkflowTurn(bodies({ checkout: wf }), task());
    expect(parked.status).toBe('continue');
    expect(parked.commands).toEqual([{ kind: 'waitSignal', seq: 0, signal: 'approve' }]);

    // Delivered THIS turn as a pendingSignal (not yet in history) → resolves inline, no re-suspend.
    const viaPending = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({ pendingSignals: [{ seq: 0, signal: 'approve', payload: { by: 'davi' } }] }),
    );
    expect(viaPending.status).toBe('completed');
    expect(viaPending.output).toEqual({ approval: { by: 'davi' } });

    // Resolved on a LATER turn from history.
    const viaHistory = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({ history: [{ seq: 0, kind: 'signal', output: { by: 'ana' } }] }),
    );
    expect(viaHistory.output).toEqual({ approval: { by: 'ana' } });
  });

  it('suspends on ctx.startChild and resumes with the child output from history', async () => {
    const wf: WorkflowBody = (ctx) => ({ child: ctx.startChild('sub', 7) });
    const t1 = await runWorkflowTurn(bodies({ checkout: wf }), task());
    expect(t1.commands).toEqual([{ kind: 'startChild', seq: 0, workflow: 'sub', input: 7 }]);

    const t2 = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({ history: [{ seq: 0, kind: 'child', name: 'sub', output: { r: 14 } }] }),
    );
    expect(t2.status).toBe('completed');
    expect(t2.output).toEqual({ child: { r: 14 } });
  });

  it('a recorded step FAILURE surfaces as a catchable error (compensate or propagate)', async () => {
    const propagate: WorkflowBody = (ctx) => ctx.step('charge');
    const failed = await runWorkflowTurn(
      bodies({ checkout: propagate }),
      task({ history: [{ seq: 0, kind: 'call', name: 'charge', error: { message: 'declined' } }] }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.error?.message).toBe('declined');

    // The same failure is catchable in the body — it then completes normally.
    const caught: WorkflowBody = (ctx) => {
      try {
        ctx.step('charge');
        return { ok: true };
      } catch (err) {
        return { caught: (err as Error).message };
      }
    };
    const recovered = await runWorkflowTurn(
      bodies({ checkout: caught }),
      task({ history: [{ seq: 0, kind: 'call', name: 'charge', error: { message: 'declined' } }] }),
    );
    expect(recovered.status).toBe('completed');
    expect(recovered.output).toEqual({ caught: 'declined' });
  });

  it('records ctx.now() / ctx.sideEffect() once (recordStep) and replays the captured value', async () => {
    let clock = 1_700_000_000_000;
    const wf: WorkflowBody = (ctx) => {
      const at = ctx.now();
      const id = ctx.sideEffect(() => 'id-abc');
      return { at, id };
    };
    const t1 = await runWorkflowTurn(bodies({ checkout: wf }), task(), { now: () => clock });
    expect(t1.status).toBe('completed');
    expect(t1.output).toEqual({ at: 1_700_000_000_000, id: 'id-abc' });
    // Emitted recordStep commands so the engine persists the captured values (name `now#<seq>` / `sideEffect`).
    expect(t1.commands).toEqual([
      expect.objectContaining({
        kind: 'recordStep',
        seq: 0,
        name: 'now#0',
        output: 1_700_000_000_000,
      }),
      expect.objectContaining({ kind: 'recordStep', seq: 1, name: 'sideEffect', output: 'id-abc' }),
    ]);

    // On replay the recorded values come from history — the clock/side-effect fn are NOT re-run.
    clock = 9_999_999_999_999;
    const replay = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({
        history: [
          { seq: 0, kind: 'step', name: 'now#0', output: 1_700_000_000_000 },
          { seq: 1, kind: 'step', name: 'sideEffect', output: 'id-abc' },
        ],
      }),
      { now: () => clock },
    );
    expect(replay.output).toEqual({ at: 1_700_000_000_000, id: 'id-abc' });
    expect(replay.commands).toEqual([]); // both replayed as `found` — nothing new
  });

  it('fails LOUDLY on a nondeterministic history mismatch (code changed under an in-flight run)', async () => {
    const wf: WorkflowBody = (ctx) => ctx.step('charge');
    const d = await runWorkflowTurn(
      bodies({ checkout: wf }),
      // history says seq 0 was a `timer`, but the replay reached a `call` — divergence.
      task({ history: [{ seq: 0, kind: 'timer' }] }),
    );
    expect(d.status).toBe('failed');
    expect(d.error?.message).toContain('history at seq 0');
  });

  it('returns a no_workflow failure when the name is unregistered', async () => {
    const d = await runWorkflowTurn(bodies({}), task({ workflow: 'ghost' }));
    expect(d.status).toBe('failed');
    expect(d.error).toMatchObject({ code: 'no_workflow' });
    expect(d.error?.message).toContain("'ghost'");
  });

  it('bails at the op boundary with a cancelled decision when isCancelled fires', async () => {
    const wf: WorkflowBody = (ctx) => {
      ctx.step('a'); // first op — cancellation checked here
      return null;
    };
    const d = await runWorkflowTurn(bodies({ checkout: wf }), task(), {
      isCancelled: () => true,
    });
    expect(d.status).toBe('cancelled');
    expect(d.commands).toEqual([]); // bailed before emitting the call
  });

  it('streams local-step lifecycle via onStep (best-effort observability)', async () => {
    const events: WorkflowStepEvent[] = [];
    const wf: WorkflowBody = (ctx) => ctx.sideEffect(() => 'v');
    await runWorkflowTurn(bodies({ checkout: wf }), task(), {
      now: () => 1000,
      onStep: (e) => events.push(e),
    });
    expect(events.map((e) => e.phase)).toEqual(['running', 'completed']);
    expect(events[1]).toMatchObject({ name: 'sideEffect', output: 'v', startedAt: 1000 });
  });
});

describe('runWorkflowTurn — parallel fan-out (ctx.gatherCalls / ctx.gatherChildren)', () => {
  it('dispatches ALL gathered steps in ONE decision (not N sequential turns), then aggregates in input order', async () => {
    // The body gathers THREE steps at once. The point of the fan-out: one turn emits three `call`
    // commands (parallel), not three turns of one call each.
    const wf: WorkflowBody = (ctx) => {
      const [a, b, c] = ctx.gatherCalls([
        { name: 's1', input: 1 },
        { name: 's2', input: 2 },
        { name: 's3', input: 3 },
      ]);
      return { a, b, c };
    };

    // Turn 1 — empty history: ALL THREE dispatch AT ONCE, each stamped with the SAME parallelGroup, and
    // the turn suspends. MUTATION ANCHOR (dispatch-all-at-once): if the fan emitted only the first
    // member (or suspended after one), commands.length would be 1, not 3.
    const t1 = await runWorkflowTurn(bodies({ checkout: wf }), task(), { partition: 'acme' });
    expect(t1.status).toBe('continue');
    expect(t1.commands).toEqual([
      { kind: 'call', seq: 0, name: 's1', group: 'acme', input: 1, parallelGroup: 'gather:0' },
      { kind: 'call', seq: 1, name: 's2', group: 'acme', input: 2, parallelGroup: 'gather:0' },
      { kind: 'call', seq: 2, name: 's3', group: 'acme', input: 3, parallelGroup: 'gather:0' },
    ]);

    // Turn 2 — only seq 0 has landed: the fan must NOT complete (wait-for-ALL) and must re-dispatch ONLY
    // the still-missing members (re-dispatch avoidance — seq 0 is not re-emitted). MUTATION ANCHOR
    // (wait-for-all): if the fan completed on partial history, this would be `completed`, not `continue`.
    const t2 = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({ history: [{ seq: 0, kind: 'call', name: 's1', output: 'A' }] }),
      { partition: 'acme' },
    );
    expect(t2.status).toBe('continue');
    expect(t2.commands).toEqual([
      { kind: 'call', seq: 1, name: 's2', group: 'acme', input: 2, parallelGroup: 'gather:0' },
      { kind: 'call', seq: 2, name: 's3', group: 'acme', input: 3, parallelGroup: 'gather:0' },
    ]);

    // Turn 3 — every member resolved: replay returns the outputs in INPUT order and the body completes.
    const t3 = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({
        history: [
          { seq: 0, kind: 'call', name: 's1', output: 'A' },
          { seq: 1, kind: 'call', name: 's2', output: 'B' },
          { seq: 2, kind: 'call', name: 's3', output: 'C' },
        ],
      }),
      { partition: 'acme' },
    );
    expect(t3.status).toBe('completed');
    expect(t3.commands).toEqual([]); // all replayed as found — nothing new
    expect(t3.output).toEqual({ a: 'A', b: 'B', c: 'C' });
  });

  it('a gathered step call takes its own explicit group, else inherits the workflow partition', async () => {
    const wf: WorkflowBody = (ctx) => {
      ctx.gatherCalls([
        { name: 'x', input: 1, group: 'pinned' },
        { name: 'y', input: 2 },
      ]);
      return null;
    };
    const t1 = await runWorkflowTurn(bodies({ checkout: wf }), task(), { partition: 'acme' });
    expect(t1.commands).toEqual([
      { kind: 'call', seq: 0, name: 'x', group: 'pinned', input: 1, parallelGroup: 'gather:0' },
      { kind: 'call', seq: 1, name: 'y', group: 'acme', input: 2, parallelGroup: 'gather:0' },
    ]);
  });

  it('waitAll aggregates a member failure into a catchable gather_failed decision', async () => {
    const wf: WorkflowBody = (ctx) =>
      ctx.gatherCalls([{ name: 's1' }, { name: 's2' }, { name: 's3' }]);
    // All three resolved, the middle one failed → waitAll records all then throws the aggregate.
    const d = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({
        history: [
          { seq: 0, kind: 'call', name: 's1', output: 'A' },
          { seq: 1, kind: 'call', name: 's2', error: { message: 's2 boom' } },
          { seq: 2, kind: 'call', name: 's3', output: 'C' },
        ],
      }),
    );
    expect(d.status).toBe('failed');
    expect(d.error?.code).toBe('gather_failed');
    expect(d.error?.message).toContain('s2');
    // The per-item failures ride the wire (parity with Python's GatherFailed dict).
    expect((d.error as { errors?: unknown[] }).errors).toEqual([
      { name: 's2', error: { message: 's2 boom' } },
    ]);

    // The same aggregate is catchable in the body — it then completes normally (saga/compensation).
    const caught: WorkflowBody = (ctx) => {
      try {
        ctx.gatherCalls([{ name: 's1' }, { name: 's2' }]);
        return { ok: true };
      } catch (err) {
        return { caught: (err as Error).message };
      }
    };
    const recovered = await runWorkflowTurn(
      bodies({ checkout: caught }),
      task({
        history: [
          { seq: 0, kind: 'call', name: 's1', output: 'A' },
          { seq: 1, kind: 'call', name: 's2', error: { message: 'nope' } },
        ],
      }),
    );
    expect(recovered.status).toBe('completed');
    expect(recovered.output).toEqual({ caught: 'gather: 1 item(s) failed: s2' });
  });

  it('failFast short-circuits on the first resolved failure WITHOUT waiting for the rest', async () => {
    const wf: WorkflowBody = (ctx) =>
      ctx.gatherCalls([{ name: 's1' }, { name: 's2' }, { name: 's3' }], { mode: 'failFast' });
    // seq 0 done, seq 1 FAILED, seq 2 still absent. waitAll would suspend (seq 2 pending); failFast must
    // fail NOW. MUTATION ANCHOR: break the failFast branch (fall through to waitAll) and the seq-2-
    // pending path suspends → status 'continue', not 'failed'.
    const d = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({
        history: [
          { seq: 0, kind: 'call', name: 's1', output: 'A' },
          { seq: 1, kind: 'call', name: 's2', error: { message: 'fast boom' } },
        ],
      }),
    );
    expect(d.status).toBe('failed');
    expect(d.error?.code).toBe('gather_failed');
    expect((d.error as { errors?: { name: string }[] }).errors).toEqual([
      { name: 's2', error: { message: 'fast boom' } },
    ]);
  });

  it('gatherChildren fans out N child workflows at once, waits for all, aggregates in input order', async () => {
    const wf: WorkflowBody = (ctx) => ({ kids: ctx.gatherChildren('sub', [10, 20]) });
    const t1 = await runWorkflowTurn(bodies({ checkout: wf }), task());
    expect(t1.status).toBe('continue');
    expect(t1.commands).toEqual([
      { kind: 'startChild', seq: 0, workflow: 'sub', input: 10, parallelGroup: 'gather:0' },
      { kind: 'startChild', seq: 1, workflow: 'sub', input: 20, parallelGroup: 'gather:0' },
    ]);

    // One child landed → still waiting on the other (re-dispatch only the missing one).
    const t2 = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({ history: [{ seq: 0, kind: 'child', name: 'sub', output: { r: 1 } }] }),
    );
    expect(t2.status).toBe('continue');
    expect(t2.commands).toEqual([
      { kind: 'startChild', seq: 1, workflow: 'sub', input: 20, parallelGroup: 'gather:0' },
    ]);

    const t3 = await runWorkflowTurn(
      bodies({ checkout: wf }),
      task({
        history: [
          { seq: 0, kind: 'child', name: 'sub', output: { r: 1 } },
          { seq: 1, kind: 'child', name: 'sub', output: { r: 2 } },
        ],
      }),
    );
    expect(t3.status).toBe('completed');
    expect(t3.output).toEqual({ kids: [{ r: 1 }, { r: 2 }] });
  });

  it('an empty gather is a degenerate identity — no seqs consumed, no commands', async () => {
    const wf: WorkflowBody = (ctx) => {
      const calls = ctx.gatherCalls([]);
      const kids = ctx.gatherChildren('sub', []);
      // The next op must still get seq 0 — an empty gather reserved nothing.
      const paid = ctx.step('charge');
      return { calls, kids, paid };
    };
    const d = await runWorkflowTurn(bodies({ checkout: wf }), task(), { partition: 'acme' });
    expect(d.status).toBe('continue');
    expect(d.commands).toEqual([
      { kind: 'call', seq: 0, name: 'charge', group: 'acme', input: undefined },
    ]);
  });

  it('bails at the fan boundary with a cancelled decision when isCancelled fires', async () => {
    const wf: WorkflowBody = (ctx) => ctx.gatherCalls([{ name: 'a' }, { name: 'b' }]);
    const d = await runWorkflowTurn(bodies({ checkout: wf }), task(), { isCancelled: () => true });
    expect(d.status).toBe('cancelled');
    expect(d.commands).toEqual([]); // bailed before emitting any call
  });
});

describe('isWorkflowTask — shape discrimination (spec §6.3)', () => {
  it('is true for a workflow-shaped payload, false for a step task / junk', () => {
    expect(isWorkflowTask({ workflow: 'checkout', history: [] })).toBe(true);
    expect(isWorkflowTask({ runId: 'r', seq: 0, name: 'charge', input: {} })).toBe(false); // a step
    expect(isWorkflowTask({ workflow: 'checkout' })).toBe(false); // no history array
    expect(isWorkflowTask(null)).toBe(false);
    expect(isWorkflowTask('nope')).toBe(false);
  });
});

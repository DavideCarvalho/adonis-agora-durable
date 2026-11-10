import { CONTROL_FLOW_SIGNAL } from './control-flow-signal.js';
import type {
  HistoryEvent,
  StepError,
  WorkflowCommand,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from './interfaces.js';

/**
 * The shared, PURE "run one workflow turn" body — the TypeScript twin of the Python
 * `durable_worker/workflow.py` (`WorkflowContext` + `process_workflow_task`). Given a {@link WorkflowTask}
 * (a workflow name + input + the run's resolved `history`) it REPLAYS the registered body
 * deterministically and produces a {@link WorkflowDecision} (dispatch steps / sleep / wait-signal /
 * start-child / complete / fail / suspend). It owns NO store and does NO I/O beyond the body itself, so
 * BOTH a store-less worker (the {@link import('./worker-runtime/worker-runtime.js').WorkerRuntime}
 * consuming `workflow` jobs off `${P}-tasks-<token>`) AND the engine (via
 * {@link import('./remote-workflow-executor.js').LocalWorkflowTurnExecutor}) drive a TS workflow turn
 * through the exact same code — the same way the engine's `RemoteWorkflowExecutor` drives a Python
 * worker's turn. It is Lucid-free (imports only interface TYPES), so it rides the lean `/worker` subpath.
 *
 * The wire it emits is byte-compatible with aviary: every `ctx.*` op is keyed by a deterministic `seq`;
 * an op already resolved in `history` returns its recorded value (never re-run), and the FIRST
 * unresolved blocking op (step/sleep/waitSignal/startChild) suspends the turn, emitting its command.
 * `ctx.now()`/`ctx.sideEffect()` run inline and record their result once (a `recordStep` local step) so
 * a non-deterministic capture happens exactly once and replays the same value.
 */

/** A step/call/child the workflow awaited resolved to a FAILURE. Thrown by the replaying op so a
 *  workflow body can `try/catch` it (compensate, or let it propagate to fail the run) — the TS twin of
 *  the Python `StepFailed`. Carries the structured {@link StepError} the engine recorded. */
export class WorkflowStepFailedError extends Error {
  readonly error: StepError;
  constructor(error: StepError | undefined) {
    super(error?.message ?? 'step failed');
    this.name = 'WorkflowStepFailedError';
    this.error = error ?? { message: 'step failed' };
  }
}

/** One failed member of a `ctx.gatherCalls` / `ctx.gatherChildren` fan — its label (the step/child
 *  `name`) and the structured {@link StepError} the engine recorded. Mirrors the per-item dicts the
 *  Python `GatherFailed` carries. */
export interface GatherItemError {
  name: string;
  error: StepError;
}

/** One or more members of a parallel fan-out ({@link WorkflowTurnCtx.gatherCalls} /
 *  {@link WorkflowTurnCtx.gatherChildren}) resolved to a failure. Subclasses {@link WorkflowStepFailedError}
 *  so it is catchable in a workflow body exactly like any awaited failure AND settles the turn as a
 *  `failed` decision via {@link runWorkflowTurn}'s existing catch — the TS twin of the Python `GatherFailed`.
 *  Its wire {@link StepError} carries the aggregate `message` (count + failing names), a `gather_failed`
 *  `code`, and the per-item `errors` list (byte-parity with what Python emits). */
export class WorkflowGatherFailedError extends WorkflowStepFailedError {
  readonly failures: GatherItemError[];
  constructor(failures: GatherItemError[]) {
    const names = failures.map((f) => f.name).join(', ');
    super({
      message: `gather: ${failures.length} item(s) failed: ${names}`,
      code: 'gather_failed',
      // `errors` is additive runtime data (parity with the Python `GatherFailed` dict); it rides the
      // wire but is not part of the strict {@link StepError} type, hence the cast.
      errors: failures,
    } as StepError);
    this.name = 'WorkflowGatherFailedError';
    this.failures = failures;
  }
}

/** The history at `seq` did not match what the replay produced there — the workflow code changed under
 *  an in-flight run. The run fails loudly rather than silently diverging (Python `NondeterminismError`). */
export class WorkflowNondeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowNondeterminismError';
  }
}

/** A cooperative cancellation raised at an op boundary when the run was cancelled mid-turn — the turn
 *  bails with a `cancelled` decision (Python `Cancelled`). */
export class WorkflowTurnCancelled extends Error {
  constructor(readonly runId: string) {
    super(`workflow run ${runId} cancelled`);
    this.name = 'WorkflowTurnCancelled';
  }
}

/**
 * Internal: stop the replay at the first unresolved blocking op (Python `_Suspend`). {@link runWorkflowTurn}
 * turns it into a `continue` decision, but a body's own `catch` around a still-pending op sees it first.
 * Stamped with {@link CONTROL_FLOW_SIGNAL}, so `isWorkflowControlFlowSignal(err)` in such a `catch`
 * recognizes it and rethrows it, instead of running cleanup that would emit extra commands into the
 * turn and corrupt the replayed history.
 */
class TurnSuspend extends Error {
  /** Marks this as a control-flow signal — see `isWorkflowControlFlowSignal`. */
  readonly [CONTROL_FLOW_SIGNAL] = true;
  constructor() {
    // Control flow, thrown at every unresolved op: skip capturing a stack trace nobody reads.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super('workflow turn suspended');
    Error.stackTraceLimit = limit;
    this.name = 'TurnSuspend';
  }
}

/** Convert an arbitrary thrown value into the wire {@link StepError} (message + optional code + stack). */
function toStepError(err: unknown): StepError {
  const e = err as { message?: string; code?: string; stack?: string };
  const out: StepError = { message: err instanceof Error ? err.message : String(err) };
  if (typeof e?.code === 'string') out.code = e.code;
  if (err instanceof Error && typeof e.stack === 'string') out.stack = e.stack;
  return out;
}

/** How a parallel fan-out settles a member failure. `waitAll` (default) waits for EVERY member to
 *  resolve, records all, then throws an aggregate {@link WorkflowGatherFailedError} if any failed;
 *  `failFast` throws the moment a resolved member is a failure (siblings already in flight are NOT
 *  force-cancelled — their eventual results are ignored). Mirrors the engine-side `ctx.all`
 *  `{ mode: 'waitAll' | 'failFast' }` and the Python worker's `wait_all` / `fail_fast`. */
export type GatherMode = 'waitAll' | 'failFast';

/** One member of a {@link WorkflowTurnCtx.gatherCalls} fan — a step to dispatch (routed by handler
 *  `name`), its `input`, and an optional isolation `group` (defaults to the workflow's own partition,
 *  exactly like {@link WorkflowTurnCtx.step}). The object form of the Python `gather_calls` entry. */
export interface GatherCall {
  name: string;
  input?: unknown;
  group?: string;
}

/**
 * The replay context handed to a worker-side workflow body. Deterministic: same code + same history ⇒
 * same seqs ⇒ same decisions. Every method is SYNCHRONOUS — an op either returns its replayed value or
 * throws {@link TurnSuspend} to end the turn — so a body reads as ordinary straight-line code (mirrors
 * the Python `WorkflowContext`; the worker-side twin of the store-backed {@link import('./interfaces.js').WorkflowCtx}).
 */
export interface WorkflowTurnCtx {
  /** The run being advanced (the id the engine minted), or `undefined` for a bare test context. */
  readonly runId: string | undefined;
  /**
   * Dispatch a step (routed by handler `name`) and await its result — ALWAYS durable, engine-scheduled.
   * On replay returns the recorded output; the first turn that reaches it emits a `call` command and
   * suspends. `group` is the isolation PARTITION suffix (defaults to the workflow's own partition), NOT
   * a base queue — the engine composes the dispatch queue as `tenantGroup(sanitize(name), group)`.
   */
  step(name: string, input?: unknown, opts?: { group?: string }): unknown;
  /** Durably sleep `ms`; the run suspends and the engine resumes it when the timer fires. */
  sleep(ms: number): void;
  /** Block until a signal `name` is delivered to this run; returns its payload. */
  waitSignal(name: string): unknown;
  /** Start a child run and await its output (its own durable lifecycle). */
  startChild(workflow: string, input?: unknown): unknown;
  /**
   * PARALLEL FAN-OUT of remote steps: dispatch N steps AT ONCE and await ALL their results. Reserves a
   * contiguous seq block in list order (the determinism anchor), then on the first turn emits ONE
   * `call` command per member — every one stamped with the SAME `parallelGroup` (`gather:<firstSeq>`) —
   * and suspends. Each result checkpoints independently and resumes the run; a member ALREADY in history
   * is not re-dispatched (a re-emit of a still-pending call is idempotent on the engine), so the turn
   * re-suspends until EVERY member has resolved. When all are in, outputs return in INPUT order
   * (`waitAll`), else a {@link WorkflowGatherFailedError} is thrown (`failFast` short-circuits on the
   * first resolved failure). The worker-side twin of the Python `ctx.gather_calls`; the wire it emits is
   * byte-compatible with the engine's remote fan-out (`call` + `parallelGroup`). */
  gatherCalls(calls: GatherCall[], opts?: { mode?: GatherMode }): unknown[];
  /**
   * PARALLEL FAN-OUT of child workflows: start N children AT ONCE and await ALL their outputs. Same
   * determinism/`parallelGroup`/re-dispatch-avoidance/`mode` contract as {@link gatherCalls}, over
   * `startChild` commands instead of `call`. The worker-side twin of the Python `ctx.gather_children`
   * and the counterpart of the engine-side `ctx.all`. */
  gatherChildren(workflow: string, inputs: unknown[], opts?: { mode?: GatherMode }): unknown[];
  /** A replay-stable wall-clock timestamp in epoch ms — captured once, replayed thereafter. */
  now(): number;
  /** Run `fn` ONCE, record its result, and on replay return the same value WITHOUT re-running `fn` —
   *  the general deterministic-capture primitive (Temporal's `sideEffect`). `fn` MUST be synchronous. */
  sideEffect<T>(fn: () => T): T;
}

/** A worker-side workflow body: `(ctx, input) => output`. Written as straight-line code against the
 *  {@link WorkflowTurnCtx}; the engine replays it one turn at a time. May be sync or return a promise. */
export type WorkflowBody = (ctx: WorkflowTurnCtx, input: unknown) => unknown | Promise<unknown>;

/** How registered workflow bodies are looked up by name — a `Map` or a bare resolver function. */
export type WorkflowBodyResolver =
  | ReadonlyMap<string, WorkflowBody>
  | ((name: string) => WorkflowBody | undefined);

/** The worker-side workflow consumer a transport drives: given a {@link WorkflowTask} off
 *  `${P}-tasks-<token>`, produce the {@link WorkflowDecision} to publish on `${P}-decisions`. The
 *  {@link import('./worker-runtime/worker-runtime.js').WorkerRuntime} hands one to the transport per
 *  registered workflow name; it runs the turn through {@link runWorkflowTurn}. */
export type WorkflowTurnHandler = (task: WorkflowTask) => Promise<WorkflowDecision>;

/** Optional hooks for {@link runWorkflowTurn}. */
export interface RunWorkflowTurnOptions {
  /** Streams each local step's lifecycle (running → completed/failed) AS IT HAPPENS, so a long inline
   *  turn's steps show up live instead of only in the final decision. Best-effort — a throwing sink
   *  never fails the turn (mirrors the Python `on_step`). */
  onStep?: (event: WorkflowStepEvent) => void;
  /** Lets the replay bail at an op boundary when the run was cancelled mid-turn (→ `cancelled`
   *  decision). Called with the run id at every durable op (Python `is_cancelled`). */
  isCancelled?: (runId: string) => boolean;
  /** The worker's own partition — a `ctx.step` with no explicit `group` inherits it, so a workflow and
   *  its steps share the same isolation suffix (Python threads this in as the worker's `group`). */
  partition?: string | undefined;
  /** Clock for `ctx.now()`/`ctx.sideEffect` timing (injectable for a deterministic test). Default `Date.now`. */
  now?: () => number;
}

function resolveBody(resolver: WorkflowBodyResolver, name: string): WorkflowBody | undefined {
  return typeof resolver === 'function' ? resolver(name) : resolver.get(name);
}

class TurnContext implements WorkflowTurnCtx {
  readonly commands: WorkflowCommand[] = [];
  readonly #history: Map<number, HistoryEvent>;
  readonly #signalsBySeq: Map<number, { seq: number; signal: string; payload: unknown }>;
  readonly #partition: string | undefined;
  readonly #onStep: RunWorkflowTurnOptions['onStep'];
  readonly #isCancelled: RunWorkflowTurnOptions['isCancelled'];
  readonly #now: () => number;
  #seq = 0;

  constructor(
    readonly runId: string | undefined,
    history: HistoryEvent[],
    pendingSignals: WorkflowTask['pendingSignals'],
    opts: RunWorkflowTurnOptions,
  ) {
    this.#history = new Map(history.map((e) => [e.seq, e]));
    this.#signalsBySeq = new Map((pendingSignals ?? []).map((s) => [s.seq, s]));
    this.#partition = opts.partition;
    this.#onStep = opts.onStep;
    this.#isCancelled = opts.isCancelled;
    this.#now = opts.now ?? Date.now;
  }

  /** Every durable op takes its seq from here — the single choke point where between-op cancellation
   *  is enforced for the whole workflow API. */
  #next(): number {
    if (this.#isCancelled && this.runId !== undefined && this.#isCancelled(this.runId)) {
      throw new WorkflowTurnCancelled(this.runId);
    }
    return this.#seq++;
  }

  /** The raw history entry at `seq` (or undefined), enforcing the kind/name nondeterminism guard. */
  #replayEntry(seq: number, kind: HistoryEvent['kind'], name?: string): HistoryEvent | undefined {
    const ev = this.#history.get(seq);
    if (ev === undefined) return undefined;
    const nameMismatch = name !== undefined && ev.name !== undefined && ev.name !== name;
    if (ev.kind !== kind || nameMismatch) {
      throw new WorkflowNondeterminismError(
        `history at seq ${seq} is ${ev.kind}/${String(ev.name)}, but replay reached ${kind}/${String(name)}`,
      );
    }
    return ev;
  }

  /** `[found, output]` for a resolved op in history; throws on a recorded failure (a catchable
   *  {@link WorkflowStepFailedError}) so awaited failures surface exactly like a rejected await. */
  #replay(seq: number, kind: HistoryEvent['kind'], name?: string): [boolean, unknown] {
    const ev = this.#replayEntry(seq, kind, name);
    if (ev === undefined) return [false, undefined];
    if (ev.error != null) throw new WorkflowStepFailedError(ev.error);
    return [true, ev.output];
  }

  #emitStep(event: WorkflowStepEvent): void {
    if (!this.#onStep) return;
    try {
      this.#onStep(event);
    } catch {
      /* live-tail is best-effort observability — a broken sink must never fail the workflow */
    }
  }

  step(name: string, input: unknown = undefined, opts: { group?: string } = {}): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'call', name);
    if (found) return output;
    const group = opts.group ?? this.#partition ?? '';
    this.commands.push({ kind: 'call', seq, name, group, input });
    throw new TurnSuspend();
  }

  sleep(ms: number): void {
    const seq = this.#next();
    const [found] = this.#replay(seq, 'timer');
    if (found) return;
    this.commands.push({ kind: 'sleep', seq, ms });
    throw new TurnSuspend();
  }

  waitSignal(name: string): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'signal', name);
    if (found) return output;
    const sig = this.#signalsBySeq.get(seq);
    if (sig !== undefined) return sig.payload;
    this.commands.push({ kind: 'waitSignal', seq, signal: name });
    throw new TurnSuspend();
  }

  startChild(workflow: string, input: unknown = undefined): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'child', workflow);
    if (found) return output;
    this.commands.push({ kind: 'startChild', seq, workflow, input });
    throw new TurnSuspend();
  }

  /** Collect outputs from a list of history entries in list order, throwing an aggregate
   *  {@link WorkflowGatherFailedError} if any member resolved to a failure — the shared tail of both
   *  gather ops (the TS twin of the Python `_aggregate`). `label` names the failing member in the
   *  aggregate error (the step/child `name`). */
  #aggregate(
    entries: (HistoryEvent | undefined)[],
    label: (ev: HistoryEvent) => string,
  ): unknown[] {
    const outputs: unknown[] = [];
    const failures: GatherItemError[] = [];
    for (const ev of entries) {
      if (ev !== undefined && ev.error != null) {
        failures.push({ name: label(ev), error: ev.error });
        outputs.push(undefined);
      } else {
        outputs.push(ev?.output);
      }
    }
    if (failures.length > 0) throw new WorkflowGatherFailedError(failures);
    return outputs;
  }

  gatherCalls(calls: GatherCall[], opts: { mode?: GatherMode } = {}): unknown[] {
    // Empty fan: reserve no seqs and produce no side effects (degenerate identity) — matches Python.
    if (calls.length === 0) return [];
    const mode = opts.mode ?? 'waitAll';
    // Reserve the whole block in list order BEFORE any dispatch — replay re-derives identical seqs.
    const seqs = calls.map(() => this.#next());
    const firstSeq = seqs[0] as number;
    const parallelGroup = `gather:${firstSeq}`;
    const entries = calls.map((c, i) => this.#replayEntry(seqs[i] as number, 'call', c.name));

    // failFast: bail the moment any ALREADY-resolved member is a failure (siblings are left in flight).
    if (mode === 'failFast') {
      for (let i = 0; i < entries.length; i += 1) {
        const ev = entries[i];
        if (ev !== undefined && ev.error != null) {
          throw new WorkflowGatherFailedError([
            { name: ev.name ?? (calls[i] as GatherCall).name, error: ev.error },
          ]);
        }
      }
    }

    // Dispatch every member not yet in history — all stamped with the shared fan group — then suspend
    // ONCE. A member already resolved is skipped (no re-dispatch); a re-emit of a still-pending call is
    // idempotent on the engine, so the turn re-suspends until EVERY member has resolved.
    let pending = false;
    for (let i = 0; i < calls.length; i += 1) {
      if (entries[i] !== undefined) continue;
      const c = calls[i] as GatherCall;
      const group = c.group ?? this.#partition ?? '';
      this.commands.push({
        kind: 'call',
        seq: seqs[i] as number,
        name: c.name,
        group,
        input: c.input,
        parallelGroup,
      });
      pending = true;
    }
    if (pending) throw new TurnSuspend();

    // All resolved: outputs in INPUT order, aggregating any failures (waitAll).
    return this.#aggregate(entries, (ev) => ev.name ?? '');
  }

  gatherChildren(workflow: string, inputs: unknown[], opts: { mode?: GatherMode } = {}): unknown[] {
    if (inputs.length === 0) return [];
    const mode = opts.mode ?? 'waitAll';
    const seqs = inputs.map(() => this.#next());
    const firstSeq = seqs[0] as number;
    const parallelGroup = `gather:${firstSeq}`;
    const entries = seqs.map((seq) => this.#replayEntry(seq, 'child', workflow));

    if (mode === 'failFast') {
      for (const ev of entries) {
        if (ev !== undefined && ev.error != null) {
          throw new WorkflowGatherFailedError([{ name: workflow, error: ev.error }]);
        }
      }
    }

    let pending = false;
    for (let i = 0; i < inputs.length; i += 1) {
      if (entries[i] !== undefined) continue;
      this.commands.push({
        kind: 'startChild',
        seq: seqs[i] as number,
        workflow,
        input: inputs[i],
        parallelGroup,
      });
      pending = true;
    }
    if (pending) throw new TurnSuspend();

    return this.#aggregate(entries, () => workflow);
  }

  now(): number {
    // The seq _localStep's own #next() is about to allocate — mirror the Python `now#<seq>` name.
    return this.#localStep(`now#${this.#seq}`, () => this.#now()) as number;
  }

  sideEffect<T>(fn: () => T): T {
    return this.#localStep('sideEffect', fn) as T;
  }

  /** Run a LOCAL step once and record its result (a `recordStep` command), so a captured value happens
   *  exactly once and replay returns it. Backs {@link now} and {@link sideEffect}. */
  #localStep(name: string, body: () => unknown): unknown {
    const seq = this.#next();
    const [found, output] = this.#replay(seq, 'step', name);
    if (found) return output;

    const startedAt = this.#now();
    this.#emitStep({ runId: this.runId ?? '', seq, name, phase: 'running', startedAt });
    let result: unknown;
    try {
      result = body();
    } catch (err) {
      const error = toStepError(err);
      const finishedAt = this.#now();
      this.commands.push({ kind: 'recordStep', seq, name, error, startedAt, finishedAt });
      this.#emitStep({
        runId: this.runId ?? '',
        seq,
        name,
        phase: 'failed',
        startedAt,
        finishedAt,
        error,
      });
      throw new WorkflowStepFailedError(error);
    }
    const finishedAt = this.#now();
    this.commands.push({ kind: 'recordStep', seq, name, output: result, startedAt, finishedAt });
    this.#emitStep({
      runId: this.runId ?? '',
      seq,
      name,
      phase: 'completed',
      startedAt,
      finishedAt,
      output: result,
    });
    return result;
  }
}

/**
 * Replay one turn of `task`'s workflow against the registered `bodies` and return the wire
 * {@link WorkflowDecision}. The shared core behind the store-less worker's workflow path AND the
 * engine's in-process {@link import('./remote-workflow-executor.js').LocalWorkflowTurnExecutor} —
 * transport-free and store-free, so it is testable with a plain task object.
 *
 * Outcomes (byte-compatible with aviary / the Python `process_workflow_task`):
 * - body returns → `completed` (with `output` + any `recordStep` commands run this turn);
 * - {@link TurnSuspend} (first unresolved blocking op) → `continue` (with the blocking `commands`);
 * - {@link WorkflowTurnCancelled} → `cancelled` (partial `commands` that DID run this turn);
 * - {@link WorkflowStepFailedError} → `failed` with that step's error;
 * - any other throw → `failed` with the converted error;
 * - no registered body → `failed` `{ code: 'no_workflow' }`.
 */
export async function runWorkflowTurn(
  bodies: WorkflowBodyResolver,
  task: WorkflowTask,
  opts: RunWorkflowTurnOptions = {},
): Promise<WorkflowDecision> {
  const base = { taskId: task.taskId, runId: task.runId };
  const body = resolveBody(bodies, task.workflow);
  if (body === undefined) {
    return {
      ...base,
      status: 'failed',
      commands: [],
      error: { message: `no workflow registered for '${task.workflow}'`, code: 'no_workflow' },
    };
  }
  const ctx = new TurnContext(task.runId, task.history, task.pendingSignals, opts);
  try {
    const output = await body(ctx, task.input);
    return { ...base, status: 'completed', commands: ctx.commands, output };
  } catch (err) {
    if (err instanceof TurnSuspend) {
      return { ...base, status: 'continue', commands: ctx.commands };
    }
    if (err instanceof WorkflowTurnCancelled) {
      return { ...base, status: 'cancelled', commands: ctx.commands };
    }
    if (err instanceof WorkflowStepFailedError) {
      return { ...base, status: 'failed', commands: ctx.commands, error: err.error };
    }
    return { ...base, status: 'failed', commands: ctx.commands, error: toStepError(err) };
  }
}

/**
 * True when `task` is a WORKFLOW turn (vs a step task) — discriminated BY SHAPE (spec §6.3), byte-for-
 * byte with the Python `is_workflow_task` (`runner-core.ts`): a workflow task carries a string
 * `workflow` name AND a `history` array. Both ride the SAME `${P}-tasks-<token>` queue, so a unified
 * consumer routes turns through the replay body and steps through `runStepHandler` on this predicate.
 */
export function isWorkflowTask(data: unknown): data is WorkflowTask {
  if (typeof data !== 'object' || data === null) return false;
  const t = data as Record<string, unknown>;
  return typeof t.workflow === 'string' && Array.isArray(t.history);
}

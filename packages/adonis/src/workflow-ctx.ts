import { backoffDelay } from './backoff.js';
import { instantCheckpoint } from './checkpoints.js';
import { unwrapCompletion } from './completion.js';
import { parseDuration } from './duration.js';
import {
  ContinueAsNew,
  FatalError,
  GatherError,
  NonDeterminismError,
  SignalTimeoutError,
  WorkflowSuspended,
} from './errors.js';
import { EVENT_BUFFER_SCAN_LIMIT, eventMatches, eventToken } from './events.js';
import type {
  ChildCallOptions,
  DurableWebhook,
  SearchAttributes,
  StateStore,
  StepCheckpoint,
  StepDef,
  StepDispatchOpts,
  StepError,
  StepEvent,
  StepInvocation,
  StepKind,
  StepLogger,
  StepOptions,
  StepUndo,
  WorkflowCtx,
} from './interfaces.js';
import { breakpointToken } from './protocol.js';
import { createStepLogger } from './step-logger.js';
import { type StepConfig, type StepRef, stepConfigOf, stepNameOf } from './step-name-symbol.js';
import { type WorkflowRef, workflowName } from './workflow-ref.js';

/**
 * Merge a `@Step`-declared {@link StepConfig} with a per-call {@link StepDispatchOpts} override into
 * the dispatch-relevant `StepOptions` subset of a {@link StepDef} (`retries`/`backoff`/`backoffMs`/
 * `backoffMaxMs`/`jitter`/`timeoutMs`), `opts` winning field-by-field. Omits every field neither side
 * set — required under `exactOptionalPropertyTypes` (an explicit `undefined` value is a type error).
 */
function resolveStepPolicy(
  config: StepConfig | undefined,
  opts: StepDispatchOpts | undefined,
): StepOptions {
  const policy: StepOptions = {};
  const retries = opts?.retries ?? config?.retries;
  if (retries !== undefined) policy.retries = retries;
  const backoff = opts?.backoff ?? config?.backoff;
  if (backoff !== undefined) policy.backoff = backoff;
  const backoffMs = opts?.backoffMs ?? config?.backoffMs;
  if (backoffMs !== undefined) policy.backoffMs = backoffMs;
  const backoffMaxMs = opts?.backoffMaxMs ?? config?.backoffMaxMs;
  if (backoffMaxMs !== undefined) policy.backoffMaxMs = backoffMaxMs;
  const jitter = opts?.jitter ?? config?.jitter;
  if (jitter !== undefined) policy.jitter = jitter;
  const timeoutMs = opts?.timeoutMs ?? config?.timeoutMs;
  if (timeoutMs !== undefined) policy.timeoutMs = timeoutMs;
  const pickupTimeoutMs = opts?.pickupTimeoutMs ?? config?.pickupTimeoutMs;
  if (pickupTimeoutMs !== undefined) policy.pickupTimeoutMs = pickupTimeoutMs;
  const requires = opts?.requires ?? config?.requires;
  if (requires !== undefined) policy.requires = requires;
  return policy;
}

/** Normalize the `ctx.child`/`ctx.startChild` 3rd arg: a bare string is shorthand for `{ childId }`. */
function normalizeChildOptions(options?: string | ChildCallOptions): ChildCallOptions {
  return typeof options === 'string' ? { childId: options } : (options ?? {});
}

/**
 * A saga undo registered by a completed step, kept with its step name for visibility on failure.
 * Two shapes, pushed onto the SAME `compensations` stack so the engine unwinds them together in one
 * strict reverse-completion order, regardless of which kind each one is:
 * - `fn`: a LOCAL undo (`ctx.localStep`'s `compensate` closure) — run in-process at unwind time.
 * - `dispatch`: a DISPATCHED undo (`ctx.step`'s `compensate` ref/string) — an ordinary step def the
 *   engine dispatches to a worker at unwind time, called with the {@link StepUndo} envelope (`args`).
 */
export type Compensation =
  | { name: string; fn: () => Promise<void> }
  | {
      name: string;
      dispatch: {
        def: StepDef<StepUndo<unknown, unknown>, unknown>;
        args: StepUndo<unknown, unknown>;
      };
    };

/** A finished local step the host should checkpoint and announce (completed or failed). */
export interface StepRecord {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  input?: unknown;
  events?: StepEvent[] | undefined;
  attempts: number;
  enqueuedAt: Date;
  startedAt: Date;
  workerGroup?: string | undefined;
}

/**
 * The narrow surface {@link createWorkflowCtx} needs from the engine — the seam between the
 * authoring API (this module) and the orchestrator (the engine owns lifecycle: emitting events,
 * suspending/resuming runs, dispatching remote steps).
 */
export interface CtxHost {
  readonly store: StateStore;
  /**
   * Per-execution checkpoint snapshot, loaded ONCE at execution start (the completed prefix this
   * replay walks). Lets each primitive read the prefix from memory instead of a per-call DB SELECT
   * (the O(N²) replay-reads fix). A seq ABSENT from the map is NOT cached — the primitive falls back
   * to the live store, so the checkpoint this resume is waking on (signal/timer/child, written after
   * the snapshot) is always read fresh. New checkpoints written during this execution are inserted
   * into the map so any later same-execution read sees them. Undefined ⇒ always hit the store.
   */
  readonly replay?: Map<number, StepCheckpoint> | undefined;
  clock(): number;
  webhookUrl?: ((token: string) => string) | undefined;
  /** Mark a local step's body as started — emits `step.started` and (optionally) a `running` checkpoint. */
  startStep(step: StepRecord): Promise<void>;
  completeStep(step: StepRecord & { output: unknown }): Promise<void>;
  failStep(step: StepRecord & { error: StepError }): Promise<void>;
  callRemote<TInput, TOutput>(
    runId: string,
    seq: number,
    step: StepDef<TInput, TOutput>,
    input: TInput,
    queue?: string,
    transport?: string,
    admission?: { priority?: number | undefined; fairnessKey?: string | undefined },
  ): Promise<TOutput>;
  /** Start a child run once, deferred so it can't reentrantly resume a still-running parent. */
  startChild(workflow: string, input: unknown, id: string, priority?: number): void;
  /**
   * Best-effort cancel of a child run — deferred for the SAME reason as `startChild` (so ctx code
   * can't reentrantly mutate engine state while the parent's own step is still executing
   * synchronously). Plain cancel, no saga undo; used by `ctx.all`'s `failFast` mode to stop the
   * surviving siblings once one has failed. Cancelling an already-terminal/cancelled run is a no-op
   * (`engine.cancel`'s own idempotency guard), so a replay that re-issues the same calls is safe.
   * Optional: hosts that never construct a `ctx.all` failFast call (e.g. test fakes) can omit it.
   */
  cancelChild?(childId: string): void;
  /** Shallow-merge `attrs` into the run's `searchAttributes` (see {@link WorkflowCtx.upsertSearchAttributes}). */
  upsertSearchAttributes(runId: string, attrs: SearchAttributes): Promise<void>;
  /** Deliver an op to a durable entity (deferred), optionally with a `reply` token for the result. */
  signalEntity?(name: string, key: string, op: string, arg: unknown, reply?: string): void;
  /** Run a local step body through the registered step interceptors (identity if none). */
  interceptStep?<T>(invocation: StepInvocation, body: () => Promise<T>): Promise<T>;
}

/** The per-run logical position counter. `rewind()` gives a position back (see `ctx.patched`). */
class Position {
  private seq = -1;
  next(): number {
    this.seq += 1;
    return this.seq;
  }
  rewind(): void {
    this.seq -= 1;
  }
}

/**
 * {@link WorkflowCtx} plus the in-process `localStep` primitive. `localStep` is public on
 * `WorkflowCtx` too, so this is just a documentary alias for the library's own built-in workflows
 * (the durable-entity runner) that lean on the in-process step directly.
 */
export type InternalWorkflowCtx = WorkflowCtx;

/**
 * Build the {@link WorkflowCtx} handed to a workflow body. Every primitive is a closure over the
 * position counter (the per-run logical position) and the saga `compensations` stack, so `task`/
 * `child` compose `localStep`/`waitForSignal` directly. All durability goes through {@link CtxHost},
 * so the workflow body stays deterministic.
 */
export function createWorkflowCtx(
  host: CtxHost,
  runId: string,
  compensations: Compensation[],
  workflow = '',
): InternalWorkflowCtx {
  const { store, replay } = host;
  const pos = new Position();

  // Read the checkpoint at `seq`: from the per-execution snapshot when present (no DB round-trip),
  // otherwise from the live store. Absence in the snapshot means "written after the snapshot" (the
  // signal/timer/child this resume wakes on, or nothing yet) — those MUST hit the store. Identical
  // behaviour to a raw `store.getCheckpoint`, just memoized for the completed prefix.
  const readCheckpoint = (seq: number): Promise<StepCheckpoint | null> | StepCheckpoint => {
    const hit = replay?.get(seq);
    if (hit !== undefined) return hit;
    return store.getCheckpoint(runId, seq);
  };

  // Persist a checkpoint AND reflect it in the snapshot, so a later same-execution read of this seq
  // (e.g. a re-read within the same call) sees it instead of falling back to the store.
  const writeCheckpoint = async (cp: StepCheckpoint): Promise<void> => {
    await store.saveCheckpoint(cp);
    replay?.set(cp.seq, cp);
  };

  // The in-process local-step runner: checkpointed, replayed, retried. Public as `ctx.localStep`; also
  // backs the library's own primitives that need a checkpointed in-process body — `ctx.task`'s
  // dispatch step and the deterministic capture helpers `ctx.now`/`ctx.sideEffect`. Distinct from the
  // always-dispatched `ctx.step` below.
  const localStep = async <T>(
    name: string,
    fn: (log: StepLogger) => Promise<T>,
    options?: StepOptions,
  ): Promise<T> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.name !== name) {
      throw new NonDeterminismError(runId, current, name, existing.name);
    }
    if (existing && existing.status === 'completed') {
      // Register the compensation on replay too, so a saga undoes ALL completed steps — even
      // those done in an earlier (since-suspended) pass — not just the ones run this pass.
      if (options?.compensate) compensations.push({ name, fn: options.compensate });
      return existing.output as T;
    }
    const maxAttempts = Math.max(1, options?.retries ?? 1);
    const startedAt = new Date();
    // Announce the body has begun (and, when enabled, checkpoint it `running`) so the step is
    // visible in flight — not only once it settles. Skipped on replay: a completed step returns
    // above before reaching here, so this fires once, when the body actually first runs.
    await host.startStep({
      runId,
      seq: current,
      name,
      kind: 'local',
      attempts: 1,
      enqueuedAt: startedAt,
      startedAt,
    });
    for (let attempt = 1; ; attempt += 1) {
      // Events are scoped per attempt — a retry starts a clean log, so the checkpoint reflects
      // only the attempt that actually completed (or the final failing one).
      const events: StepEvent[] = [];
      try {
        const invocation: StepInvocation = {
          runId,
          workflow,
          stepName: name,
          seq: current,
          attempt,
        };
        const body = () => fn(createStepLogger(events, host.clock));
        const output = host.interceptStep
          ? await host.interceptStep(invocation, body)
          : await body();
        await host.completeStep({
          runId,
          seq: current,
          name,
          kind: 'local',
          output,
          events,
          attempts: attempt,
          enqueuedAt: startedAt,
          startedAt,
        });
        if (options?.compensate) compensations.push({ name, fn: options.compensate });
        return output;
      } catch (err) {
        if (err instanceof FatalError || attempt >= maxAttempts) {
          await host.failStep({
            runId,
            seq: current,
            name,
            kind: 'local',
            error: {
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
            events,
            attempts: attempt,
            enqueuedAt: startedAt,
            startedAt,
          });
          throw err;
        }
        // Wait out the backoff before the next attempt (no-op when backoffMs is unset).
        const wait = backoffDelay(attempt, options);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  // Exactly-once DB step: run the body and write the step checkpoint in ONE store transaction, so the
  // business write commits atomically with the "done" marker (a plain step checkpoints AFTER the body,
  // so a crash in between re-runs it). Replay returns the recorded output without re-running.
  const transaction = async <T>(name: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (!store.transaction) {
      throw new Error(
        'ctx.transaction needs a store that supports transactions (the SQL adapters do). Use ctx.step for non-transactional work.',
      );
    }
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.name !== name) {
      throw new NonDeterminismError(runId, current, name, existing.name);
    }
    if (existing && existing.status === 'completed') return existing.output as T;
    return store.transaction(async (tx) => {
      const output = await fn(tx.raw);
      const cp = instantCheckpoint({ runId, seq: current, name, kind: 'local', output });
      await tx.saveCheckpoint(cp);
      // Reflect the committed checkpoint in the snapshot, keeping the writeback invariant uniform.
      replay?.set(current, cp);
      return output;
    });
  };

  // Shared by sleep / sleepUntil: record a durable timer at this position and suspend until `wakeAt`
  // (epoch ms). The wakeAt is computed by the caller — but only used on the first run; on replay the
  // recorded checkpoint's wakeAt wins, so a clock change can't shift an already-scheduled timer.
  const suspendUntil = async (wakeAt: () => number): Promise<void> => {
    const current = pos.next();
    const now = host.clock();
    const existing = await readCheckpoint(current);
    if (existing) {
      // Timer already recorded: resume if due, otherwise re-suspend cheaply.
      if (now >= (existing.wakeAt ?? 0)) return;
      throw new WorkflowSuspended(existing.wakeAt ?? now);
    }
    const at = wakeAt();
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: 'sleep', kind: 'sleep', wakeAt: at }),
    );
    throw new WorkflowSuspended(at);
  };

  const sleep = (duration: string | number): Promise<void> =>
    suspendUntil(() => host.clock() + parseDuration(duration));

  const sleepUntil = (when: Date | number): Promise<void> =>
    suspendUntil(() => (typeof when === 'number' ? when : when.getTime()));

  // End this run and hand off to a fresh execution (clean history) with the new input. Terminal —
  // it always throws, so any code after it in the workflow is unreachable.
  const continueAsNew = (input?: unknown): Promise<never> => {
    throw new ContinueAsNew(input);
  };

  // NOTE (determinism): a bounded wait consumes TWO logical positions (deadline + wait), an
  // unbounded one consumes ONE. So adding or removing `{ timeoutMs }` on an existing `waitForSignal`
  // shifts the seq of every later step — treat it as a workflow-version change for in-flight runs.
  // Consume a buffered signal (one delivered before this run was waiting), recording it as the
  // signal checkpoint at `seq` so it resumes immediately instead of suspending. Replay-safe: the
  // checkpoint makes the consumption deterministic.
  const consumeBuffered = async <T>(token: string, seq: number): Promise<{ value: T } | null> => {
    const buffered = await store.takeBufferedSignal(token);
    if (!buffered) return null;
    await writeCheckpoint(
      instantCheckpoint({
        runId,
        seq,
        name: `signal:${token}`,
        kind: 'signal',
        output: buffered.payload,
      }),
    );
    return { value: buffered.payload as T };
  };

  // Consume a buffered EVENT matching `match` (one published with no live waiter — see
  // engine.publishEvent's buffering), recording it as the resolving `signal:<token>` checkpoint at
  // `seq` so replay is deterministic — the event analog of `consumeBuffered` above, but match-aware:
  // an event's buffer is keyed by NAME only (many waiters can share a name with different `match`
  // criteria), so consumption scans the oldest candidates and evaluates each one's match HERE — the
  // match predicate belongs to the WAITER, never the store (see events.ts / interfaces.ts). A hit
  // atomically claims that one row via `removeBufferedEvent`'s boolean return, which arbitrates a
  // concurrent claim (notably engine.publishEvent's own late re-check reaching the same row first);
  // losing that race tries the NEXT oldest candidate instead of giving up, so a later non-matching
  // buffered event never blocks an earlier matching one behind it.
  const consumeBufferedEvent = async <T>(
    name: string,
    match: Record<string, unknown> | undefined,
    token: string,
    seq: number,
  ): Promise<{ value: T } | null> => {
    const candidates = await store.listBufferedEvents(name, EVENT_BUFFER_SCAN_LIMIT);
    for (const candidate of candidates) {
      if (!eventMatches(candidate.payload, match ?? {})) continue;
      if (!(await store.removeBufferedEvent(candidate.id))) continue; // raced away — try the next
      // Resolved it ourselves — remove OUR OWN waiter row via the exact match (harmless here since an
      // event token is unique per call, but keeps this symmetric with the signal-side precedent).
      await store.removeSignalWaiter({ token, runId, seq });
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq,
          name: `signal:${token}`,
          kind: 'signal',
          output: candidate.payload,
        }),
      );
      return { value: candidate.payload as T };
    }
    return null;
  };

  // Durably stamp the deadline for a BOUNDED wait, ONCE: the first run computes `clock() + timeoutMs`
  // and records it as a timer checkpoint at `deadlineSeq`; every later replay reads the SAME recorded
  // `wakeAt` back instead of recomputing it — so a slow replay (or a clock that moved between the
  // original run and the replay) can never shift an already-scheduled deadline. `label` only affects
  // the checkpoint's `name` (cosmetic, for the dashboard timeline) — the shared mechanic behind every
  // bounded-wait primitive (`waitForSignal`, `waitForEvent`, `DurableWebhook.wait`).
  const stampDeadline = async (
    deadlineSeq: number,
    label: string,
    timeoutMs: number,
  ): Promise<number> => {
    const recorded = await readCheckpoint(deadlineSeq);
    const deadline = recorded?.wakeAt ?? host.clock() + timeoutMs;
    if (!recorded) {
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: deadlineSeq,
          name: `timeout:${label}`,
          kind: 'sleep',
          wakeAt: deadline,
        }),
      );
    }
    return deadline;
  };

  const waitForSignal = async <T>(token: string, opts?: { timeoutMs?: number }): Promise<T> => {
    if (opts?.timeoutMs == null) {
      const current = pos.next();
      const existing = await readCheckpoint(current);
      if (existing && existing.status === 'completed') return existing.output as T;
      const buffered = await consumeBuffered<T>(token, current);
      if (buffered) return buffered.value;
      // Register, THEN check the buffer again before suspending — closes the lost-wake window
      // between the check above and this registration: a signal delivered in that sliver found no
      // waiter (we hadn't registered yet) and no buffer either by the time IT checked, so it buffered
      // the payload; without this re-check we'd suspend with the payload sitting unpaired forever.
      // (Registering UNCONDITIONALLY before even the first check — instead of only on a miss like
      // here — reopens a worse window: a token an entity loop reuses across iterations would expose
      // a "this turn is about to self-resolve from the buffer" waiter row to a concurrent signal for
      // the NEXT iteration's payload, which can steal it via engine.signal's plain takeSignalWaiter
      // and misdeliver. Checking first, so we only ever register when we're sure no buffer already
      // existed, avoids that.) See the interleaving proof at engine.signal for the mirror-image
      // take→buffer→re-take on the signaling side that this pairs with.
      await store.putSignalWaiter({ token, runId, seq: current });
      const lateBuffered = await consumeBuffered<T>(token, current);
      if (lateBuffered) {
        // Resolved it ourselves — remove OUR OWN row via the exact match, not
        // `takeSignalWaiter(token)`, which deletes ANY row for this token and could steal a
        // different run's waiter that has since claimed the same token.
        await store.removeSignalWaiter({ token, runId, seq: current });
        return lateBuffered.value;
      }
      throw new WorkflowSuspended(undefined, [current]);
    }
    const timeoutMs = opts.timeoutMs;
    const deadlineSeq = pos.next();
    const waitSeq = pos.next();
    // The run also gets a run-level wakeAt (via WorkflowSuspended) so the timer poller resumes it at
    // the deadline.
    const deadline = await stampDeadline(deadlineSeq, token, timeoutMs);
    const waited = await readCheckpoint(waitSeq);
    if (waited && waited.status === 'completed') return waited.output as T;
    const buffered = await consumeBuffered<T>(token, waitSeq);
    if (buffered) return buffered.value;
    if (host.clock() >= deadline) {
      // A PRIOR replay of this same call may have already registered the waiter (below) before this
      // one found the deadline past — clean up that exact row (own token/runId/seq only; a plain
      // `takeSignalWaiter(token)` could otherwise steal a different run's waiter on the same token).
      // A no-op if nothing was ever registered.
      await store.removeSignalWaiter({ token, runId, seq: waitSeq }).catch(() => undefined);
      throw new SignalTimeoutError(token, timeoutMs);
    }
    // Same reorder as the unbounded arm above: check, THEN register, THEN re-check before suspending.
    await store.putSignalWaiter({ token, runId, seq: waitSeq });
    const lateBuffered = await consumeBuffered<T>(token, waitSeq);
    if (lateBuffered) {
      await store.removeSignalWaiter({ token, runId, seq: waitSeq });
      return lateBuffered.value;
    }
    throw new WorkflowSuspended(deadline, [waitSeq]);
  };

  // Wait for a named event delivered by engine.publishEvent(name, payload). Like waitForSignal, but
  // name-based pub/sub with optional `match` filtering — the token embeds name + match (see events.ts),
  // so a publish fans out to the runs whose match the payload satisfies.
  //
  // Buffering (reliable events — mirrors signalWithStart's reliability contract for signals, see the
  // "Semantics" doc on engine.publishEvent): a publish that finds no live waiter buffers ONE copy, and
  // this call's post-registration scan is what consumes it. UNLIKE waitForSignal, this registers its
  // waiter FIRST and scans the buffer only ONCE after — no separate "check before registering" pass.
  // That's deliberate: waitForSignal's own token is a caller-chosen string an entity loop can legitimately
  // REUSE across iterations, so registering before checking would expose a "this turn is about to
  // self-resolve" waiter row to a concurrent signal for the NEXT iteration's token. An event token embeds
  // this call's OWN `runId#seq` (see eventToken in events.ts) — nothing else ever mints the same token —
  // so that hazard cannot arise here, and a single check-after-register closes the lost-wake window
  // symmetrically with engine.publishEvent's own buffer-then-recheck.
  const waitForEvent = async <T>(
    name: string,
    opts?: { match?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<T> => {
    if (opts?.timeoutMs == null) {
      const current = pos.next();
      const token = eventToken(name, opts?.match, runId, current);
      const existing = await readCheckpoint(current);
      if (existing && existing.status === 'completed') return existing.output as T;
      await store.putSignalWaiter({ token, runId, seq: current });
      const bufferedHit = await consumeBufferedEvent<T>(name, opts?.match, token, current);
      if (bufferedHit) return bufferedHit.value;
      throw new WorkflowSuspended(undefined, [current]);
    }
    const timeoutMs = opts.timeoutMs;
    const deadlineSeq = pos.next();
    const waitSeq = pos.next();
    const token = eventToken(name, opts.match, runId, waitSeq);
    const deadline = await stampDeadline(deadlineSeq, `event:${name}`, timeoutMs);
    const waited = await readCheckpoint(waitSeq);
    if (waited && waited.status === 'completed') return waited.output as T;
    if (host.clock() >= deadline) {
      // Exact removal (see waitForSignal above) — takeSignalWaiter(token) deletes ANY row for this
      // token and could steal a different run's waiter registered on it after ours timed out.
      await store.removeSignalWaiter({ token, runId, seq: waitSeq }).catch(() => undefined);
      throw new SignalTimeoutError(`event:${name}`, timeoutMs);
    }
    await store.putSignalWaiter({ token, runId, seq: waitSeq });
    const bufferedHit = await consumeBufferedEvent<T>(name, opts.match, token, waitSeq);
    if (bufferedHit) return bufferedHit.value;
    throw new WorkflowSuspended(deadline, [waitSeq]);
  };

  // An external task = a checkpointed dispatch + a wait for its async-completion `Completion`
  // (delivered by engine.completeTask/failTask). The whole "fire at a foreign system, suspend,
  // resume when it reports back" pattern as one call.
  const task = async <T>(
    name: string,
    dispatch: () => Promise<void>,
    options?: StepOptions,
  ): Promise<T> => {
    await localStep(`task:dispatch:${name}`, dispatch, options);
    return unwrapCompletion<T>(await waitForSignal(`task:${runId}:${name}`), `task "${name}"`);
  };

  // Child workflow (await result): start it once, then suspend on a `child:<id>` waiter the child
  // signals on its terminal state (see engine.notifyParent).
  const child = async <T>(
    workflow: WorkflowRef,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<T> => {
    const { childId, priority } = normalizeChildOptions(options);
    const current = pos.next();
    const id = childId ?? `${runId}.child.${current}`;
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') {
      return unwrapCompletion<T>(existing.output, `child "${id}"`);
    }
    await store.putSignalWaiter({ token: `child:${id}`, runId, seq: current });
    // Lost-wake guard (mirrors the engine's remote `startChild` command path): the child may have
    // ALREADY completed while no waiter was registered — e.g. this run failed on the child's
    // failure, the child was retried to completion, and this run is now being retried — leaving its
    // completion BUFFERED. Consume it here or the re-registered waiter waits forever for a signal
    // that already fired. Resolve exactly as engine.signal would: overwrite the placeholder with
    // the completed signal checkpoint, then unwrap.
    const buffered = await store.takeBufferedSignal(`child:${id}`);
    if (buffered) {
      await store.removeSignalWaiter({ token: `child:${id}`, runId, seq: current });
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: current,
          name: `signal:child:${id}`,
          kind: 'signal',
          output: buffered.payload,
        }),
      );
      return unwrapCompletion<T>(buffered.payload, `child "${id}"`);
    }
    const childRun = await store.getRun(id);
    if (!childRun) {
      host.startChild(workflowName(workflow), input, id, priority);
    } else if (
      childRun.status === 'completed' ||
      childRun.status === 'failed' ||
      childRun.status === 'cancelled' ||
      childRun.status === 'dead'
    ) {
      // Durable lost-notify recovery: the child is ALREADY terminal but neither a live signal nor a
      // buffered completion reached this waiter — the child's `notifyParent` write was lost (crash
      // between the child's terminal write and the signal insert, or a swallowed store error). The
      // signal was the MESSENGER; the child's run row is the durable source of truth, so re-derive
      // the exact completion `notifyParent` would have delivered and resolve the wait from it.
      // Without this, every reconcile re-drive replays back here and re-suspends forever.
      const completion =
        childRun.status === 'completed'
          ? { ok: true as const, value: childRun.output }
          : { ok: false as const, error: childRun.error?.message ?? childRun.status };
      await store.removeSignalWaiter({ token: `child:${id}`, runId, seq: current });
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: current,
          name: `signal:child:${id}`,
          kind: 'signal',
          output: completion,
        }),
      );
      return unwrapCompletion<T>(completion, `child "${id}"`);
    }
    // Make the awaited child visible in the parent's timeline WHILE it runs: a `running` placeholder
    // at this seq with the same `signal:child:<id>` name the signal resolution later overwrites as
    // `completed`. So the dashboard shows the child node (and can inline-expand it) live, instead of
    // it appearing only when it finishes. Written once (skipped on replay, where `existing` is set);
    // `running` is ignored by replay history, so it never short-circuits determinism.
    if (!existing) {
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: current,
          name: `signal:child:${id}`,
          kind: 'signal',
          status: 'running',
        }),
      );
    }
    throw new WorkflowSuspended(undefined, [current]);
  };

  // Parallel child workflows (wait-all): dispatch N children CONCURRENTLY and wait for ALL their
  // outputs. Reserves a contiguous position block in list order FIRST (the determinism anchor), then
  // dispatches every not-yet-completed item and suspends once; on each child completion the parent
  // resumes and replays — completed items short-circuit, remaining ones re-register and re-suspend.
  // When all resolve, outputs are returned in INPUT order (waitAll), or a GatherError is thrown
  // carrying the per-item failures. Parity with the Python SDK's `gather_children`.
  const all = async <T = unknown>(
    workflow: WorkflowRef,
    inputs: unknown[],
    opts?: { mode?: 'waitAll' | 'failFast' },
  ): Promise<T[]> => {
    // Empty: reserve no positions and produce no side effects (degenerate identity).
    if (inputs.length === 0) return [];
    const mode = opts?.mode ?? 'waitAll';
    const name = workflowName(workflow);
    // Reserve the whole block in list order BEFORE any dispatch — replay re-derives identical seqs.
    const positions = inputs.map(() => pos.next());
    const group = `all:${positions[0]}`;
    const id = (i: number) => `${runId}.all.${positions[0]}.${i}`;
    const existing = await Promise.all(positions.map((seq) => readCheckpoint(seq)));

    // failFast: bail the moment any already-completed item is a failed Completion.
    if (mode === 'failFast') {
      for (let i = 0; i < inputs.length; i += 1) {
        const cp = existing[i];
        const c =
          cp?.status === 'completed' ? (cp.output as { ok?: boolean; error?: string }) : null;
        if (c && c.ok === false) {
          // Cancel every sibling that hasn't completed yet — plain cancel, no saga undo. Best-effort:
          // a sibling mid-step only observes the cancellation at its NEXT checkpoint (it isn't
          // force-killed mid-synchronous-execution), so a fast-enough sibling can still slip through
          // and complete before it notices. `cancelChild` is deferred (like `startChild`), and
          // cancelling an already-terminal/cancelled run is a no-op, so replaying this branch after a
          // resume (which re-executes this loop and re-issues the same cancels) is safe.
          for (let j = 0; j < inputs.length; j += 1) {
            if (j !== i && existing[j]?.status !== 'completed') host.cancelChild?.(id(j));
          }
          throw new GatherError(
            [{ index: i, id: id(i), error: c.error ?? 'unknown' }],
            inputs.length,
          );
        }
      }
    }

    // Dispatch every item not yet completed in history; write its running placeholder once.
    let pending = false;
    const pendingSeqs: number[] = [];
    for (let i = 0; i < inputs.length; i += 1) {
      const cp = existing[i];
      if (cp?.status === 'completed') continue;
      const seq = positions[i] as number;
      const childId = id(i);
      // Carry the fan `group` onto the waiter too: the child's terminal `signal:child:` checkpoint is
      // (re)written by engine.signal when the child notifies the parent, OVERWRITING the running
      // placeholder below at the same seq — so without this the resolved checkpoint would lose the
      // group and the dashboard would render the resolved fan as a sequential chain.
      await store.putSignalWaiter({ token: `child:${childId}`, runId, seq, parallelGroup: group });
      // Lost-wake guard (mirrors `child` above): a fan item's completion may have fired while no
      // waiter was registered (this run replaying after a crash/failure) — consume the BUFFERED copy,
      // or, if even that was lost, re-derive the completion from the child's own terminal run row.
      // Without this a re-driven fan re-registers its waiters and waits forever on signals that
      // already fired.
      const resolve = async (payload: unknown): Promise<StepCheckpoint> => {
        await store.removeSignalWaiter({ token: `child:${childId}`, runId, seq });
        const resolved = instantCheckpoint({
          runId,
          seq,
          name: `signal:child:${childId}`,
          kind: 'signal',
          output: payload,
          parallelGroup: group,
        });
        await writeCheckpoint(resolved);
        return resolved;
      };
      const buffered = await store.takeBufferedSignal(`child:${childId}`);
      if (buffered) {
        existing[i] = await resolve(buffered.payload);
        continue;
      }
      const childRun = await store.getRun(childId);
      if (!childRun) {
        host.startChild(name, inputs[i], childId);
      } else if (
        childRun.status === 'completed' ||
        childRun.status === 'failed' ||
        childRun.status === 'cancelled' ||
        childRun.status === 'dead'
      ) {
        existing[i] = await resolve(
          childRun.status === 'completed'
            ? { ok: true, value: childRun.output }
            : { ok: false, error: childRun.error?.message ?? childRun.status },
        );
        continue;
      }
      pending = true;
      pendingSeqs.push(seq);
      if (!cp) {
        await writeCheckpoint(
          instantCheckpoint({
            runId,
            seq,
            name: `signal:child:${childId}`,
            kind: 'signal',
            status: 'running',
            parallelGroup: group,
          }),
        );
      }
    }
    // Any item still outstanding → suspend once; the resume replays this whole block. Carry only
    // the STILL-PENDING seqs — a completed one would make the post-settle recheck spuriously
    // re-drive every partial fan settle.
    if (pending) throw new WorkflowSuspended(undefined, pendingSeqs);

    // All resolved: build outputs in INPUT order, aggregating any failures.
    const outputs: T[] = [];
    const failures: { index: number; id: string; error: string }[] = [];
    for (let i = 0; i < inputs.length; i += 1) {
      const c = existing[i]?.output as { ok?: boolean; value?: T; error?: string } | null;
      if (c && typeof c === 'object' && 'ok' in c && c.ok === false) {
        failures.push({ index: i, id: id(i), error: c.error ?? 'unknown' });
        outputs.push(undefined as T);
      } else {
        outputs.push((c as { value?: T } | null)?.value as T);
      }
    }
    if (failures.length > 0) throw new GatherError(failures, inputs.length);
    return outputs;
  };

  // Child workflow (fire-and-forget): dispatch it once and return its id WITHOUT suspending. The
  // start is checkpointed at this position so replay returns the same id without re-dispatching, and
  // is idempotent by id, so `child(..., sameId)` later joins the same run rather than starting a new
  // one (start + join scatter-gather).
  const startChild = async (
    workflow: WorkflowRef,
    input: unknown,
    options?: string | ChildCallOptions,
  ): Promise<string> => {
    const { childId, priority } = normalizeChildOptions(options);
    const current = pos.next();
    const id = childId ?? `${runId}.child.${current}`;
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return existing.output as string;
    if (!(await store.getRun(id))) host.startChild(workflowName(workflow), input, id, priority);
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: `spawn:${id}`, kind: 'local', output: id }),
    );
    return id;
  };

  // Call a durable entity op and await its result: register a reply waiter at this position, dispatch
  // the op with the reply token, and suspend until the entity signals the result back (checkpointed,
  // so replay returns it without re-dispatching).
  const callEntity = async <R>(
    name: string,
    key: string,
    op: string,
    arg?: unknown,
  ): Promise<R> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return existing.output as R;
    const reply = `entityreply:${runId}:${current}`;
    await store.putSignalWaiter({ token: reply, runId, seq: current });
    host.signalEntity?.(name, key, op, arg, reply);
    throw new WorkflowSuspended(undefined, [current]);
  };

  // Send a durable entity op without awaiting a result — dispatched once (checkpointed, replay-safe).
  const signalEntity = async (
    name: string,
    key: string,
    op: string,
    arg?: unknown,
  ): Promise<void> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return;
    host.signalEntity?.(name, key, op, arg);
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: `entitysig:${name}:${key}`, kind: 'local' }),
    );
  };

  // A breakpoint = a visible `pending` checkpoint + a signal waiter the dashboard resumes via
  // `engine.continue`. Reuses the signal machinery, so resume overwrites the pending checkpoint
  // with a completed one and the run replays past it.
  const breakpoint = async (label?: string): Promise<void> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing && existing.status === 'completed') return;
    if (!existing) {
      await writeCheckpoint(
        instantCheckpoint({
          runId,
          seq: current,
          name: label ? `breakpoint:${label}` : 'breakpoint',
          kind: 'signal',
          status: 'pending',
        }),
      );
      await store.putSignalWaiter({ token: breakpointToken(runId, current), runId, seq: current });
    }
    throw new WorkflowSuspended(undefined, [current]);
  };

  // Guard an in-place change: a fresh run records a `patch:<id>` marker here and takes the new
  // branch; a run recorded under the OLD code finds a real step at this position instead, so we
  // rewind the logical position (the marker is transparent to it) and return false — its replay
  // reads that old step next and follows the old branch. No position shift → no corruption.
  const patched = async (id: string): Promise<boolean> => {
    const marker = `patch:${id}`;
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing) {
      if (existing.name === marker) return true;
      if (existing.name.startsWith('patch:')) {
        throw new NonDeterminismError(runId, current, marker, existing.name);
      }
      pos.rewind(); // not a marker: an old run's step lives here — give the position back to it
      return false;
    }
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name: marker, kind: 'local', output: true }),
    );
    return true;
  };

  // An update point: suspend on a run-scoped `update:<runId>:<name>` token that engine.update
  // delivers to (after its validator passes). Reuses the signal machinery; run-scoped like task/child.
  const onUpdate = <T>(name: string, opts?: { timeoutMs?: number }): Promise<T> =>
    waitForSignal<T>(`update:${runId}:${name}`, opts);

  // A queryable named value: a checkpoint whose `name` is `event:<key>`, so the latest value for a
  // key is just the highest-seq such checkpoint (read by engine.getEvent). Replay-idempotent.
  const setEvent = async (key: string, value: unknown): Promise<void> => {
    const current = pos.next();
    const name = `event:${key}`;
    const existing = await readCheckpoint(current);
    if (existing && existing.name !== name) {
      throw new NonDeterminismError(runId, current, name, existing.name);
    }
    if (existing && existing.status === 'completed') return; // replay: already published
    await writeCheckpoint(
      instantCheckpoint({ runId, seq: current, name, kind: 'local', output: value }),
    );
  };

  // A durable webhook reserves a logical position NOW to mint a stable token, so the url can be
  // handed to a third party before `wait()` suspends. `wait()` then parks on that same position
  // until the callback lands as engine.signal(token, body) — single position, replay-safe. The
  // deadline (when `wait({ timeoutMs })` is used) is a SEPARATE, later position — reserved lazily by
  // `wait()` itself, not at mint time, since the mint site has no `opts` to know a timeout was
  // requested. That's fine: `wait()` runs in the same deterministic order on every replay, so the
  // deadline seq it claims is stable too.
  const webhook = <T>(): DurableWebhook<T> => {
    const current = pos.next();
    const token = `wh:${runId}:${current}`;
    const wait = async (opts?: { timeoutMs?: number }): Promise<T> => {
      // A bounded wait claims its deadline position UNCONDITIONALLY, before the completed-replay
      // early return: the same `wait({ timeoutMs })` call re-runs on every replay, so the position
      // walk must be identical whether the callback has landed yet or not. (Claiming it lazily after
      // the early return would shift every later primitive by one on the post-callback replay and
      // trip the NonDeterminism guard on the stamped `timeout:*` checkpoint.)
      const timeoutMs = opts?.timeoutMs;
      const deadlineSeq = timeoutMs == null ? -1 : pos.next();
      const existing = await readCheckpoint(current);
      if (existing && existing.status === 'completed') return existing.output as T;
      if (timeoutMs == null) {
        await store.putSignalWaiter({ token, runId, seq: current });
        throw new WorkflowSuspended(undefined, [current]);
      }
      const deadline = await stampDeadline(deadlineSeq, token, timeoutMs);
      if (host.clock() >= deadline) {
        await store.takeSignalWaiter(token).catch(() => undefined);
        throw new SignalTimeoutError(token, timeoutMs);
      }
      await store.putSignalWaiter({ token, runId, seq: current });
      throw new WorkflowSuspended(deadline, [current]);
    };
    return { token, url: host.webhookUrl?.(token), wait };
  };

  // Deterministic capture: run `fn` once, checkpoint its output, and replay the SAME value verbatim
  // afterwards (fn is NOT re-run on replay). The general primitive for any non-deterministic value the
  // author controls the generator for — `ctx.sideEffect(() => uuidv7())`, `() => Math.random()`, a
  // config/env read. A raw `Date.now()`/`Math.random()` in a workflow body differs across replays and
  // corrupts the run; this captures it deterministically. Replaces the removed `ctx.random`/`ctx.uuid`.
  const sideEffect = <T>(fn: () => T | Promise<T>): Promise<T> =>
    localStep('sideEffect', async () => fn());
  // `now` is the one ubiquitous convenience (a single obvious implementation, epoch ms like
  // `Date.now()`); everything else uses `sideEffect` so the author picks the generator.
  const now = () => localStep('now', async () => host.clock());

  // Merge into this run's searchAttributes exactly once: a checkpoint at this position marks it done,
  // so a replay SKIPS the write (mirrors `transaction` / the instant primitives) instead of re-merging
  // on every turn. Nondeterminism-guarded by the recorded marker name.
  const upsertSearchAttributes = async (attrs: SearchAttributes): Promise<void> => {
    const current = pos.next();
    const existing = await readCheckpoint(current);
    if (existing) {
      if (existing.name !== 'searchAttributes') {
        throw new NonDeterminismError(runId, current, 'searchAttributes', existing.name);
      }
      return;
    }
    await host.upsertSearchAttributes(runId, attrs);
    await writeCheckpoint(
      instantCheckpoint({
        runId,
        seq: current,
        name: 'searchAttributes',
        kind: 'local',
        output: attrs,
      }),
    );
  };

  // Resolve a `ctx.step(..., { compensate })` ref/string into the undo's own dispatchable StepDef —
  // same routing-name resolution as the step it's attached to, but its dispatch policy comes ONLY from
  // its own `@Step`-stamped config (stepConfigOf), never the compensated call's per-call `opts`: the
  // undo is a separately-declared handler with its own retry/backoff, not an extension of the step it
  // undoes. The string form (cross-runtime) has no stamped config, so it dispatches with engine
  // defaults. Takes `unknown` (like `stepNameOf`/`stepConfigOf`) — the caller's TInput/TOutput are
  // call-site type params with no runtime shape to check here; the compile-time contract is already
  // enforced by `WorkflowCtx.step`'s overload signature.
  function resolveCompensateDef(compensate: unknown): StepDef<StepUndo<unknown, unknown>, unknown> {
    const undoName = typeof compensate === 'string' ? compensate : stepNameOf(compensate);
    if (undoName === undefined) {
      throw new Error(
        'ctx.step: compensate handler is not a @Step reference (no stamped step name) — pass a @Step/defineStep handler or a step name string',
      );
    }
    const config = typeof compensate === 'string' ? undefined : stepConfigOf(compensate);
    return { name: undoName, ...resolveStepPolicy(config, undefined) };
  }

  // ONE durable step primitive: always dispatched, always engine-scheduled — no local/remote
  // placement choice for the workflow author (see `WorkflowCtx.step`). Resolve the routing name off a
  // `@Step`-stamped handler reference, or take it literally for the cross-runtime string form; the
  // reference itself is NEVER invoked here — only its stamped name (and dispatch policy) is read. The
  // effective durable-retry/liveness policy is `{ ...stepConfigOf(handlerOrName), ...opts }`, a per-
  // call `opts` field winning wherever set; the string form has no stamped config, so it uses `opts`
  // only. Carrying this onto the `StepDef` re-enables `callRemote`'s durable retry/backoff and
  // liveness-timeout branches (see `engine.ts`).
  function step<TInput, TOutput>(
    handlerOrName: StepRef<TInput, TOutput> | string,
    input: TInput,
    opts?: StepDispatchOpts & { compensate?: StepRef<StepUndo<TInput, TOutput>, unknown> | string },
  ): Promise<TOutput> {
    const name = typeof handlerOrName === 'string' ? handlerOrName : stepNameOf(handlerOrName);
    if (name === undefined) {
      throw new Error(
        'ctx.step: handler is not a @Step reference (no stamped step name) — pass a @Step/defineStep handler or a step name string',
      );
    }
    const config = typeof handlerOrName === 'string' ? undefined : stepConfigOf(handlerOrName);
    const def: StepDef<TInput, TOutput> = { name, ...resolveStepPolicy(config, opts) };
    return host
      .callRemote(runId, pos.next(), def, input, opts?.queue, opts?.transport, {
        priority: opts?.priority,
        fairnessKey: opts?.fairnessKey,
      })
      .then((output) => {
        // `callRemote` resolves ONLY once this step is durably complete (the replay-completed branch,
        // or the in-memory `timeoutMs` liveness path once the live result lands). Register the
        // dispatched compensation HERE, after resolution, so a saga only undoes steps that actually
        // finished — `input`/`output` come straight from this call (the checkpointed ones on replay).
        if (opts?.compensate) {
          compensations.push({
            name,
            dispatch: {
              def: resolveCompensateDef(opts.compensate),
              args: { input, output },
            },
          });
        }
        return output;
      });
  }

  return {
    runId,
    step,
    localStep,
    upsertSearchAttributes,
    transaction,
    callEntity,
    signalEntity,
    sleep,
    sleepUntil,
    continueAsNew,
    waitForSignal,
    waitForEvent,
    task,
    child,
    all,
    startChild,
    breakpoint,
    webhook,
    setEvent,
    onUpdate,
    patched,
    now,
    sideEffect,
  };
}

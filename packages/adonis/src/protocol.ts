import { runInStepLogger } from './ambient-step.js';
import type { Heartbeat, RemoteTask, StepEvent, StepLogger, StepResult } from './interfaces.js';
import { createStepLogger } from './step-logger.js';
import { runOutsideWorkflowCtx } from './workflow-als.js';

/**
 * The scoped-restore slot `@adonis-agora/context` exposes:
 * `<T>(snapshot: Record<string, unknown> | undefined, fn: () => T) => T`. It runs `fn` INSIDE a
 * freshly-activated context store seeded from `snapshot` (or just `fn()` when snapshot/slot is
 * absent). Read structurally so a worker restores the originating request's userRef/tenant/traceId
 * around a step handler with zero config when context is installed — and a clean no-op (`fn()`) when
 * it is not. Wrapping (rather than the old `:set`, which only populates an already-active store) gives
 * both correct propagation AND per-task isolation on a long-lived worker: each task runs in its own
 * scope, so context never bleeds between tasks. The key is a global-registry symbol so it survives
 * duplicate copies of either package in a dependency tree.
 */
const CONTEXT_SCOPE = Symbol.for('@agora/context:scope');

type ContextScope = <T>(snapshot: Record<string, unknown> | undefined, fn: () => T) => T;

/**
 * Run `fn` inside the originating request's context (userRef/tenant/traceId), restored from the
 * task's snapshot (stamped at dispatch by the originating engine, see {@link RemoteTask.context}),
 * so a step handler sees it with no manual code. When `@adonis-agora/context` is not installed (slot
 * absent) the body runs directly — a clean no-op fallback. Never throws from the propagation path: a
 * non-function slot is ignored; errors inside `fn` propagate as the step's own failure (the scope
 * helper itself re-throws nothing of its own).
 */
function withRestoredContext<T>(snapshot: Record<string, unknown> | undefined, fn: () => T): T {
  const scope = (globalThis as Record<symbol, unknown>)[CONTEXT_SCOPE];
  if (typeof scope !== 'function') return fn();
  return (scope as ContextScope)(snapshot, fn);
}

/** How often a workflow worker beats for a turn it is replaying (the Python `durable-worker` uses 5s). */
export const TURN_HEARTBEAT_INTERVAL_MS = 5_000;

/** How long a step marked {@link RemoteTask.lazyPickupBeat} runs before its worker sends the pickup
 *  heartbeat. */
export const PICKUP_BEAT_GRACE_MS = 1_000;

/**
 * Run a workflow turn while emitting RUN-scoped heartbeats (`{ runId, seq: 0, group }`, no `stepId`):
 * one right away, then every `intervalMs` until the turn settles. They keep an engine that set
 * `remoteAdvanceSilenceMs` from re-driving a turn that is still being replayed. Best-effort: a failed
 * publish never breaks the turn.
 */
export async function withTurnHeartbeat<T>(
  task: { runId: string; group: string },
  publish: (beat: Heartbeat) => Promise<void>,
  turn: () => Promise<T>,
  intervalMs: number = TURN_HEARTBEAT_INTERVAL_MS,
): Promise<T> {
  const beat = (): void => {
    void Promise.resolve()
      .then(() => publish({ runId: task.runId, seq: 0, group: task.group, at: Date.now() }))
      .catch(() => undefined);
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  (timer as { unref?: () => void }).unref?.();
  try {
    return await turn();
  } finally {
    clearInterval(timer);
  }
}

/** Canonical step id — the stable identity of a step within a run, used for dedupe and
 *  correlation. The format is part of the cross-language wire contract (Python builds the same). */
export function stepId(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

/** Deterministic signal token a breakpoint suspends on — derived from its logical position. Shared
 *  so `ctx.breakpoint` (which records it) and `engine.continue` (which signals it) agree. */
export const breakpointToken = (runId: string, seq: number): string => `bp:${runId}:${seq}`;

/** A remote-worker step body. The optional `log` records sub-process outcomes and debug/error
 *  lines that ride back on the result — the TypeScript twin of the Python SDK's `StepContext`. */
export type StepHandler = (input: unknown, log: StepLogger) => Promise<unknown> | unknown;

/**
 * Run `handler` for `task` and produce the wire-format {@link StepResult}. Pure (no transport,
 * no I/O beyond the handler), so every transport — and any language port — can share the exact
 * same completed / failed / no-handler contract instead of re-deriving it.
 *
 * `signal` becomes the handler's {@link StepLogger.signal}: a transport passes one it aborts when its
 * `close()` starts, so a long step can stop between units of work instead of being cut off.
 */
export async function runStepHandler(
  task: RemoteTask,
  handler: StepHandler | undefined,
  emitBeat?: (beat: Heartbeat) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<StepResult> {
  // Stamp the worker's pickup time so the engine can report queue-wait (startedAt − enqueuedAt).
  // This is the one place every transport funnels through, so timing comes for free everywhere.
  const base = { runId: task.runId, seq: task.seq, stepId: task.stepId, startedAt: Date.now() };
  if (!handler) {
    return {
      ...base,
      status: 'failed',
      error: { message: `no handler for ${task.name}`, retryable: false },
    };
  }
  const events: StepEvent[] = [];
  const withEvents = (result: StepResult): StepResult =>
    events.length > 0 ? { ...result, events } : result;
  // Run the handler INSIDE the originating request's context (userRef/tenant/traceId), restored from
  // the task snapshot, so cross-process propagation is automatic — `ctx.step(remoteStep, input)`
  // carries the caller's context with zero manual serialize/deserialize, and each task runs in its
  // own scope (no cross-task bleed on a long-lived worker). No-op without `@adonis-agora/context`.
  // Wire `log.heartbeat(progress)` to the transport's heartbeat lane (fire-and-forget — a lost beat
  // costs one liveness update, never the step). Absent emitter (a transport without heartbeats, or a
  // local in-process run) → the logger's heartbeat is a no-op.
  const beat = emitBeat
    ? (progress?: unknown): void => {
        void Promise.resolve(
          emitBeat({
            runId: task.runId,
            seq: task.seq,
            stepId: task.stepId,
            group: task.group,
            at: Date.now(),
            ...(progress === undefined ? {} : { progress }),
          }),
        ).catch(() => undefined);
      }
    : undefined;
  // Automatic pickup beat: the moment a worker claims the task, tell the engine "execution
  // started". This is what lets `pickupTimeoutMs` (queue-wait allowance) hand over to the tighter
  // `timeoutMs` (max silence while running) — and it stamps `lastHeartbeatAt` even for handlers
  // that never beat manually, so "queued" vs "executing" is visible on the checkpoint.
  const pickup = task.lazyPickupBeat && beat ? setTimeout(beat, PICKUP_BEAT_GRACE_MS) : undefined;
  pickup?.unref?.();
  if (!pickup) beat?.();
  const handlerBeat =
    beat && pickup
      ? (progress?: unknown): void => {
          clearTimeout(pickup);
          beat(progress);
        }
      : beat;
  const settled = withRestoredContext(task.context, async () => {
    try {
      // Outside any ambient workflow ctx: an in-process transport runs the handler on the parent
      // body's async path, but a handler is not the body (see `runOutsideWorkflowCtx`).
      const logger = createStepLogger(events, Date.now, handlerBeat, signal);
      const output = await runOutsideWorkflowCtx(() =>
        runInStepLogger(logger, () => handler(task.input, logger)),
      );
      return withEvents({ ...base, status: 'completed', output });
    } catch (err) {
      // Carry `code`/`retryable` off the thrown error if present, so the engine's durable retry can
      // honour a worker's "don't retry this" verdict (e.g. a declined card).
      const e = err as { message?: string; code?: string; retryable?: boolean; details?: unknown };
      return withEvents({
        ...base,
        status: 'failed',
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof e?.code === 'string' ? { code: e.code } : {}),
          ...(e?.details !== undefined ? { details: e.details } : {}),
          ...(typeof e?.retryable === 'boolean' ? { retryable: e.retryable } : {}),
        },
      });
    }
  });
  try {
    return await settled;
  } finally {
    clearTimeout(pickup);
  }
}

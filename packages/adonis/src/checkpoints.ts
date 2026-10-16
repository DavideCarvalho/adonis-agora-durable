import type { StepCheckpoint, StepError, StepEvent, StepKind } from './interfaces.js';
import { stepId } from './protocol.js';

/**
 * The step-event names the lost-dispatch self-heal stamps on a checkpoint's trail, so an operator (and
 * the dashboard, which renders a step's events under it) can tell a re-drive apart from an ordinary
 * failure retry WITHOUT a schema change: `step.redispatched` = the dispatched job was presumed lost
 * (its lease lapsed with no result and no heartbeat) and the step was re-enqueued; `step.lost` = the
 * re-drive bound (`remoteRedispatchMax`) ran out and the step was failed `remote_step_lost`.
 */
export const REDISPATCHED_STEP_EVENT = 'step.redispatched';
export const LOST_STEP_EVENT = 'step.lost';

/**
 * A `warn` step event recording a lost-dispatch re-drive (or the give-up at its bound). `attempts` is
 * the dispatch count AFTER the transition, so the trail reads as the attempt an operator sees on the
 * checkpoint.
 */
export function lostStepEvent(
  at: number,
  attempts: number,
  outcome: 'redispatched' | 'lost',
): StepEvent {
  return {
    at,
    level: 'warn',
    name: outcome === 'lost' ? LOST_STEP_EVENT : REDISPATCHED_STEP_EVENT,
    message:
      outcome === 'lost'
        ? `dispatch lost and the re-drive bound is spent after ${attempts} dispatch(es) — failing the step`
        : `re-dispatched after a lost dispatch (attempt ${attempts}): the step's lease lapsed with no result and no heartbeat`,
  };
}

/** Drop an empty events array to `undefined` (the repeated `events?.length ? events : undefined`). */
function nonEmptyEvents(events: StepEvent[] | undefined): StepEvent[] | undefined {
  return events && events.length > 0 ? events : undefined;
}

/**
 * Build a *phased* step checkpoint — one with distinct enqueue/run/finish timestamps (a local step
 * that is running/completed/failed, or a pending remote/sleep step). Computes the deterministic
 * `stepId` and normalizes empty event arrays, so the engine's running/completed/failed/pending
 * checkpoint literals are constructed in exactly one place instead of ~8.
 *
 * For instantaneous checkpoints (sleep timers, markers, delivered signals) use {@link instantCheckpoint}.
 */
export function stepCheckpoint(p: {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  status: StepCheckpoint['status'];
  attempts: number;
  enqueuedAt: Date;
  startedAt: Date;
  finishedAt: Date;
  input?: unknown;
  output?: unknown;
  error?: StepError | undefined;
  events?: StepEvent[] | undefined;
  workerGroup?: string | undefined;
  wakeAt?: number | undefined;
  parallelGroup?: string | undefined;
}): StepCheckpoint {
  return {
    runId: p.runId,
    seq: p.seq,
    name: p.name,
    kind: p.kind,
    stepId: stepId(p.runId, p.seq),
    status: p.status,
    input: p.input,
    output: p.output,
    error: p.error,
    events: nonEmptyEvents(p.events),
    attempts: p.attempts,
    workerGroup: p.workerGroup,
    wakeAt: p.wakeAt,
    parallelGroup: p.parallelGroup,
    enqueuedAt: p.enqueuedAt,
    startedAt: p.startedAt,
    finishedAt: p.finishedAt,
  };
}

/**
 * Build an *instantaneous* checkpoint — one with no distinct enqueue/run/finish phases (a durable
 * sleep timer, a breakpoint marker, a delivered signal, a published `setEvent` value, a `patched`
 * marker). All three timestamps collapse to now and `attempts` is 1. Collapses what was five
 * near-identical 10-field `saveCheckpoint({...})` literals into one builder.
 */
export function instantCheckpoint(p: {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  status?: StepCheckpoint['status'];
  output?: unknown;
  wakeAt?: number;
  parallelGroup?: string | undefined;
}): StepCheckpoint {
  const at = new Date();
  return {
    runId: p.runId,
    seq: p.seq,
    name: p.name,
    kind: p.kind,
    stepId: stepId(p.runId, p.seq),
    status: p.status ?? 'completed',
    output: p.output,
    wakeAt: p.wakeAt,
    parallelGroup: p.parallelGroup,
    attempts: 1,
    enqueuedAt: at,
    startedAt: at,
    finishedAt: at,
  };
}

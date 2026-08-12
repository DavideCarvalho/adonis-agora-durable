import type { StepCheckpoint } from './durable-client.js';

/** Prefix the engine writes on a compensation checkpoint's `name` (`compensate:<originalStepName>`). */
export const COMPENSATE_PREFIX = 'compensate:';

/** Strip the `compensate:` prefix for display (e.g. list rows); non-compensation names pass through
 *  unchanged. The step-detail panel keeps the full, prefixed name — this is display-only. */
export function compensationDisplayName(name: string): string {
  return name.startsWith(COMPENSATE_PREFIX) ? name.slice(COMPENSATE_PREFIX.length) : name;
}

/**
 * Split a run's timeline into its normal body and its saga compensations, per the engine's negative-
 * seq convention: a body step is always `seq >= 0`; the k-th compensation to run (reverse
 * registration order) owns `seq = -(k+1)`, so `seq: -1` ran FIRST. Compensation checkpoints must
 * never mix into the body's graph/spans rendering or step counts — this is the one place that draws
 * the line, so every consumer (dashboard + flip) splits the exact same way.
 */
export function splitCompensations(timeline: StepCheckpoint[]): {
  body: StepCheckpoint[];
  compensations: StepCheckpoint[];
} {
  const body: StepCheckpoint[] = [];
  const compensations: StepCheckpoint[] = [];
  for (const step of timeline) {
    if (step.seq < 0) {
      compensations.push(step);
    } else {
      body.push(step);
    }
  }
  // Descending by seq (-1, -2, -3, …) recovers unwind order — the order the undos actually ran in.
  compensations.sort((a, b) => b.seq - a.seq);
  return { body, compensations };
}

export interface CompensationSummary {
  total: number;
  done: number;
  failed: number;
  pending: number;
}

/** Tally a compensation group's outcomes for the run-header chip and banner copy. `pending` covers
 *  both `pending` (dispatched, in flight) and `running` (a local undo's closure executing now). */
export function compensationSummary(compensations: StepCheckpoint[]): CompensationSummary {
  let done = 0;
  let failed = 0;
  let pending = 0;
  for (const step of compensations) {
    if (step.status === 'completed') done++;
    else if (step.status === 'failed') failed++;
    else pending++;
  }
  return { total: compensations.length, done, failed, pending };
}

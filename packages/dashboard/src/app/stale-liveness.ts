import type { GroupHealth, StepCheckpoint } from '../client/durable-client';

/** A worker heartbeat older than this is treated as dead for the stale-pending row (heartbeats
 *  refresh every ~30s; 90s tolerates two missed refreshes before declaring the worker gone). */
export const LIVE_BEAT_WINDOW_MS = 90_000;

/**
 * What a stale `pending` remote step row should say — resolved from the group's live worker health
 * instead of the wall clock alone.
 *
 * "Dispatched Nm ago" is only HALF the story: a long-running step (a 100MB ingestion read) looks
 * identical to a genuinely lost dispatch if all you consult is time. The transport already knows the
 * difference — workers heartbeat their groups (`/workers`, `GroupHealth.liveWorkers`) — so:
 *
 * - a live heartbeat on the step's group ⇒ `working`: the dispatch reached a worker that is still
 *   alive and (when the SDK reports it) actively executing (`inFlight`). Render calm, not alarming.
 * - no live heartbeat ⇒ `lost`: nobody is serving the group — the original warning (re-dispatch)
 *   stands.
 *
 * Honest limitation, learned the hard way: a live heartbeat proves the WORKER process is alive, not
 * that the step is progressing — a deadlocked worker keeps heartbeating on a timer. Work-level
 * progress needs the step handler to report (a future worker-SDK API); until then `working` means
 * "delivered and held by a live worker", which already separates the two situations a human must
 * treat differently (wait vs. re-dispatch).
 */
export type StalePendingView =
  | { kind: 'working'; instanceId: string; beatAgoS: number; inFlight: number | undefined }
  | { kind: 'lost'; minutes: number };

export function stalePendingView(
  step: StepCheckpoint,
  health: GroupHealth | undefined,
  nowMs: number,
): StalePendingView {
  const live = (health?.liveWorkers ?? [])
    .filter((w) => nowMs - w.lastBeatAt <= LIVE_BEAT_WINDOW_MS)
    .sort((a, b) => b.lastBeatAt - a.lastBeatAt)[0];
  if (live) {
    return {
      kind: 'working',
      instanceId: live.instanceId,
      beatAgoS: Math.max(0, Math.round((nowMs - live.lastBeatAt) / 1000)),
      inFlight: live.status?.inFlight,
    };
  }
  const dispatchedAt = step.enqueuedAt
    ? new Date(step.enqueuedAt).getTime()
    : new Date(step.startedAt).getTime();
  return { kind: 'lost', minutes: Math.round((nowMs - dispatchedAt) / 60_000) };
}

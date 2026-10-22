import { type RunStatus, TERMINAL_RUN_STATUSES, type WorkflowRun } from './interfaces.js';

/**
 * Reserved engine tag marking a run that holds a durable singleton slot. Written only by a store's
 * {@link StateStore.tryAdmitSingleton} (inside its atomic claim), stripped from every fresh run's
 * tags, and cleared when the run reaches a terminal status. The slot is independent of the execution
 * lease: a holder that sleeps, waits on a signal, is parked `blocked` or has its lease expire keeps it.
 */
export const SINGLETON_ADMITTED_TAG = 'durable:singleton:admitted';

/** The statuses a singleton run occupies its key in — as a holder or as a FIFO waiter. */
export const SINGLETON_ACTIVE_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'blocked',
];

/** The same `(createdAt, id)` total order every instance uses for the FIFO waiter queue. */
function byCreation(a: WorkflowRun, b: WorkflowRun): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

/**
 * The admission decision, given every active run of `workflow` sharing `tag` (a superset is fine: the
 * filter is re-applied here). Returns the candidate's new tags when it is (or already was) admitted,
 * `null` when it must wait. Call only inside a store's atomic critical section — between a read that
 * serialized competing claims and the write of the returned tags.
 *
 * Holders (runs carrying {@link SINGLETON_ADMITTED_TAG}) always keep their slot; only the slots they
 * leave free go to the oldest unadmitted waiters, so a later or same-millisecond start can never
 * displace a holder.
 */
export function singletonAdmissionTags(
  runs: WorkflowRun[],
  runId: string,
  tag: string,
  workflow: string,
  limit: number,
): string[] | null {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('singleton limit must be a positive integer');
  }
  const active = runs.filter(
    (run) =>
      run.workflow === workflow &&
      SINGLETON_ACTIVE_STATUSES.includes(run.status) &&
      run.tags?.includes(tag),
  );
  const candidate = active.find((run) => run.id === runId);
  if (!candidate) return null;
  if (candidate.tags?.includes(SINGLETON_ADMITTED_TAG)) return candidate.tags ?? [];
  const holders = active.filter((run) => run.tags?.includes(SINGLETON_ADMITTED_TAG)).length;
  const free = limit - holders;
  if (free <= 0) return null;
  const waiters = active
    .filter((run) => !run.tags?.includes(SINGLETON_ADMITTED_TAG))
    .sort(byCreation);
  if (!waiters.slice(0, free).some((run) => run.id === runId)) return null;
  return [...(candidate.tags ?? []), SINGLETON_ADMITTED_TAG];
}

/**
 * The patch that parks a denied candidate on its retry timer, or `undefined` when nothing may be
 * written: the run is gone, or it already left the active set (a concurrent `cancel` settled it) —
 * a denial must never overwrite that and resurrect the run. Apply it under the same locks as the read.
 */
export function singletonAdmissionDenialPatch(
  runs: WorkflowRun[],
  runId: string,
  tag: string,
  workflow: string,
  retryWakeAt?: number,
): { status: 'suspended'; wakeAt: number; updatedAt: Date } | undefined {
  if (retryWakeAt === undefined) return undefined;
  const candidate = runs.find(
    (run) =>
      run.id === runId &&
      run.workflow === workflow &&
      SINGLETON_ACTIVE_STATUSES.includes(run.status) &&
      run.tags?.includes(tag),
  );
  if (!candidate) return undefined;
  return { status: 'suspended', wakeAt: retryWakeAt, updatedAt: new Date() };
}

/** Whether a run patch settles the run terminally (and so must release its singleton slot). */
export function settlesTerminally(patch: Partial<WorkflowRun>): boolean {
  return (
    patch.status !== undefined &&
    (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(patch.status)
  );
}

/** `tags` without the admission marker, or `undefined` when nothing changes. */
export function withoutAdmission(tags: string[] | undefined): string[] | undefined {
  if (!tags?.includes(SINGLETON_ADMITTED_TAG)) return undefined;
  return tags.filter((t) => t !== SINGLETON_ADMITTED_TAG);
}

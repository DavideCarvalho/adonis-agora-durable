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

/** The statuses the pre-0.51 scan admission ranked a key's runs in (it ignored `pending`/`blocked`). */
const LEGACY_SCAN_STATUSES: RunStatus[] = ['running', 'suspended'];

/**
 * The runs of `active` holding a slot under the PRE-ATOMIC scheme (0.50 and older): untagged runs the
 * old scan admits. That scan wrote no marker — a run was admitted while it ranked among the `limit`
 * oldest `running`/`suspended` runs of the key by `(createdAt, id)` — so during a rolling upgrade a
 * holder admitted by an old replica carries no {@link SINGLETON_ADMITTED_TAG}.
 *
 * The discriminator is POSITIONAL, not per-row: an old replica's denied waiters and the new scheme's
 * ({@link singletonAdmissionDenialPatch}) are written identically (`suspended`, retry `wakeAt`, no tag),
 * and an old holder that sleeps or waits on a signal is `suspended` too, so no column tells them apart.
 * What does is the old rule itself, applied to the current rows: the untagged runs ranked inside the
 * old scan's window — the `limit` oldest of the key's `running`/`suspended` runs plus every tagged
 * holder (so a tagged holder parked `blocked` keeps its seat). An untagged run in that window is
 * exactly a run an old replica treats as admitted.
 *
 * The FIFO waiter queue alone already keeps a slot for an untagged holder OLDER than the candidate;
 * counting the window explicitly also covers the orders it misses — a tagged holder ranking after
 * untagged runs (createdAt skew between replicas), or an older still-`pending` run the old scan never
 * saw. A run the old scan itself admitted out of order (past an older `pending` run) sits outside the
 * window and stays invisible, exactly as it is to every old replica.
 *
 * In a fleet with no old replica left, the window can also contain new-scheme waiters. Counting them
 * as holders only ever errs towards denying, never towards over-admission, and keeps the FIFO order:
 * a window member is older than every `running`/`suspended` run outside it and the candidate never
 * counts itself. Without createdAt skew every tagged holder sits inside the window too (it was
 * admitted ahead of every younger waiter), so the oldest waiters are admitted on their own retry
 * exactly as before. Only when skew ranks a tagged holder behind `limit` untagged runs does the
 * window fill with waiters — precisely the runs an old replica would treat as admitted — and they
 * then wait for that holder to settle instead of risking a second executor.
 */
function legacyHolders(active: WorkflowRun[], runId: string, limit: number): Set<string> {
  const window = active
    .filter(
      (run) =>
        LEGACY_SCAN_STATUSES.includes(run.status) || run.tags?.includes(SINGLETON_ADMITTED_TAG),
    )
    .sort(byCreation)
    .slice(0, limit);
  return new Set(
    window
      .filter((run) => run.id !== runId && !run.tags?.includes(SINGLETON_ADMITTED_TAG))
      .map((run) => run.id),
  );
}

/**
 * The admission decision, given every active run of `workflow` sharing `tag` (a superset is fine: the
 * filter is re-applied here). Returns the candidate's new tags when it is (or already was) admitted,
 * `null` when it must wait. Call only inside a store's atomic critical section — between a read that
 * serialized competing claims and the write of the returned tags.
 *
 * Holders (runs carrying {@link SINGLETON_ADMITTED_TAG}) always keep their slot; only the slots they
 * leave free go to the oldest unadmitted waiters, so a later or same-millisecond start can never
 * displace a holder. Holders a pre-atomic (0.50 and older) replica admitted without the tag are
 * counted too (see {@link legacyHolders}), so a fleet mid rolling upgrade never admits past `limit`.
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
  const legacy = legacyHolders(active, runId, limit);
  const holders =
    active.filter((run) => run.tags?.includes(SINGLETON_ADMITTED_TAG)).length + legacy.size;
  const free = limit - holders;
  if (free <= 0) return null;
  const waiters = active
    .filter((run) => !run.tags?.includes(SINGLETON_ADMITTED_TAG) && !legacy.has(run.id))
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

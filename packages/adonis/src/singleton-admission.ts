import { type RunStatus, TERMINAL_RUN_STATUSES, type WorkflowRun } from './interfaces.js';

/**
 * Reserved engine tag marking a run that holds a durable singleton slot. Written only by a store's
 * {@link StateStore.tryAdmitSingleton} (inside its atomic claim), stripped from every fresh run's
 * tags, and cleared when the run reaches a terminal status. The slot is independent of the execution
 * lease: a holder that sleeps, waits on a signal, is parked `blocked` or has its lease expire keeps it.
 */
export const SINGLETON_ADMITTED_TAG = 'durable:singleton:admitted';

/**
 * Reserved engine tag marking a not-yet-admitted singleton run whose admission is decided by the tag
 * scheme: it holds no slot unless it also carries {@link SINGLETON_ADMITTED_TAG}. Stamped on the run's
 * first execution (in the same write that sets it `running`, before it competes) and on every denial;
 * removed on admission, terminal settlement and requeue. An untagged executed run WITHOUT it was
 * executed (admitted) by a replica older than 0.51 — see {@link legacySingletonHolders}.
 */
export const SINGLETON_TRACKED_TAG = 'durable:singleton:tracked';

/** Tags only the engine and the store may write; stripped from a fresh run's user-supplied tags. */
export const SINGLETON_RESERVED_TAGS: readonly string[] = [
  SINGLETON_ADMITTED_TAG,
  SINGLETON_TRACKED_TAG,
];

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

/** `tags` without the engine's singleton markers (admitted and tracked). */
export function withoutSingletonMarkers(tags: string[] | undefined): string[] | undefined {
  return tags?.filter((tag) => !SINGLETON_RESERVED_TAGS.includes(tag));
}

/** `tags` carrying {@link SINGLETON_TRACKED_TAG} (returned unchanged when admitted or already tracked). */
export function withSingletonTracked(tags: string[] | undefined): string[] {
  const current = tags ?? [];
  if (current.includes(SINGLETON_ADMITTED_TAG) || current.includes(SINGLETON_TRACKED_TAG)) {
    return current;
  }
  return [...current, SINGLETON_TRACKED_TAG];
}

/**
 * The runs of `active`, other than `runId`, that may hold a slot WITHOUT carrying
 * {@link SINGLETON_ADMITTED_TAG}: holders admitted by a replica older than 0.51, during a rolling
 * upgrade that mixes old and new replicas.
 *
 * Old replicas admit by a scan: a run may execute while it ranks among the `limit` oldest
 * `running`/`suspended` runs of the key by `(createdAt, id)`, and they write no tag. Among those
 * statuses an untagged run counts as a legacy holder when either:
 *
 * - it lacks {@link SINGLETON_TRACKED_TAG}. A new replica stamps that marker on a run's first
 *   execution and on every denial, so an untagged executed run without it was executed — admitted —
 *   by an old replica, wherever it ranks (an old replica can admit a run past an older `pending` one
 *   it never saw). A denial alone can't be told from a holder (both park the run `suspended` on a
 *   retry `wakeAt`, exactly like a holder sleeping in `ctx.sleep`), which is why the marker exists.
 *   Waiters an old replica parked count too until a new replica re-checks them (one retry, ~1s):
 *   that only delays, never over-admits.
 * - it sits inside the old scan's own window (the `limit` oldest of those runs, every tagged holder
 *   keeping its seat in it). An old replica can admit a run a new replica had marked without clearing
 *   the marker; the window is what it admitted it on. With no old replica left this never changes a `limit: 1` decision (a run inside the window
 *   is the head of the FIFO, admitted next anyway); with a larger limit it can only delay one.
 */
export function legacySingletonHolders(
  active: WorkflowRun[],
  runId: string,
  limit: number,
): WorkflowRun[] {
  const scanned = active
    .filter((run) => LEGACY_SCAN_STATUSES.includes(run.status))
    .sort(byCreation);
  // The old scan's window, with every tagged holder given its seat in it whatever its status: a
  // holder parked `blocked` is invisible to the old scan, and without its seat the window would fill
  // with the tracked waiters behind it, each counting the next as a holder.
  const window = new Set(
    active
      .filter(
        (run) =>
          LEGACY_SCAN_STATUSES.includes(run.status) || run.tags?.includes(SINGLETON_ADMITTED_TAG),
      )
      .sort(byCreation)
      .slice(0, limit)
      .map((run) => run.id),
  );
  return scanned.filter(
    (run) =>
      run.id !== runId &&
      !run.tags?.includes(SINGLETON_ADMITTED_TAG) &&
      (!run.tags?.includes(SINGLETON_TRACKED_TAG) || window.has(run.id)),
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
 * counted too (see {@link legacySingletonHolders}), so a fleet mid rolling upgrade never admits past
 * `limit`. Admission replaces the candidate's {@link SINGLETON_TRACKED_TAG} with the admitted tag.
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
  const legacy = new Set(legacySingletonHolders(active, runId, limit).map((run) => run.id));
  const holders =
    active.filter((run) => run.tags?.includes(SINGLETON_ADMITTED_TAG)).length + legacy.size;
  const free = limit - holders;
  if (free <= 0) return null;
  const waiters = active
    .filter((run) => !run.tags?.includes(SINGLETON_ADMITTED_TAG) && !legacy.has(run.id))
    .sort(byCreation);
  if (!waiters.slice(0, free).some((run) => run.id === runId)) return null;
  return [
    ...(candidate.tags ?? []).filter((t) => t !== SINGLETON_TRACKED_TAG),
    SINGLETON_ADMITTED_TAG,
  ];
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
): { status: 'suspended'; wakeAt: number; tags: string[]; updatedAt: Date } | undefined {
  if (retryWakeAt === undefined) return undefined;
  const candidate = runs.find(
    (run) =>
      run.id === runId &&
      run.workflow === workflow &&
      SINGLETON_ACTIVE_STATUSES.includes(run.status) &&
      run.tags?.includes(tag),
  );
  if (!candidate) return undefined;
  // Marked as a waiter the tag scheme tracks, so it is never mistaken for a legacy holder.
  return {
    status: 'suspended',
    wakeAt: retryWakeAt,
    tags: withSingletonTracked(candidate.tags),
    updatedAt: new Date(),
  };
}

/** Whether a run patch settles the run terminally (and so must release its singleton slot). */
export function settlesTerminally(patch: Partial<WorkflowRun>): boolean {
  return (
    patch.status !== undefined &&
    (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(patch.status)
  );
}

/** `tags` without the singleton markers (admitted and tracked), or `undefined` when nothing changes. */
export function withoutAdmission(tags: string[] | undefined): string[] | undefined {
  if (!tags?.some((t) => SINGLETON_RESERVED_TAGS.includes(t))) return undefined;
  return withoutSingletonMarkers(tags);
}

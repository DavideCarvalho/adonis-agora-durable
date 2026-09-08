import type {
  RunQuery,
  RunResult,
  RunStatus,
  StepCheckpoint,
  WorkflowEngine,
  WorkflowRun,
} from '../index.js';

export interface ListRunsOptions {
  /** Filter by run status (pending | running | suspended | completed | failed | cancelled | dead). */
  status?: RunStatus | undefined;
  /**
   * Match any of these statuses (`status IN (...)`) — used internally by the `--stale` filter to scope
   * the query to `running`/`suspended` (the only statuses that can carry a stranded pending step)
   * instead of scanning every terminal run. Ignored when `status` is also set (the single status wins,
   * matching {@link RunQuery}'s own precedence).
   */
  statuses?: RunStatus[] | undefined;
  /** Filter by workflow name. */
  workflow?: string | undefined;
  /**
   * Max rows. Default 50. A cap, not a page window: the CLI listing has no `--offset`/`--page`
   * companion, so this stays spelled `limit` and maps to the query's `size` (page 1) internally.
   */
  limit?: number | undefined;
}

/** Anything that can list runs and their checkpoints — both a {@link WorkflowEngine} and a raw
 *  `StateStore` satisfy it. */
export interface RunLister {
  listRuns(query: RunQuery): Promise<WorkflowRun[]>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;
}

/** Query recent runs, newest activity first (the source returns its own order). */
export async function listRuns(source: RunLister, opts: ListRunsOptions): Promise<WorkflowRun[]> {
  return source.listRuns({
    ...(opts.status ? { status: opts.status } : opts.statuses ? { statuses: opts.statuses } : {}),
    ...(opts.workflow ? { workflow: opts.workflow } : {}),
    size: opts.limit ?? 50,
  });
}

/**
 * Retry a run: re-enqueue it for a worker to (re-)execute via the engine's `requeue` (the
 * dispatch-model retry — sets it back to `pending`, clears any stale lease, replays its checkpoints).
 * Returns the enqueued result, or null if the run is unknown.
 */
export async function retryRun(engine: WorkflowEngine, runId: string): Promise<RunResult | null> {
  return engine.requeue(runId);
}

// ---------------------------------------------------------------------------
// Liveness — telling "working" apart from "stranded"
// ---------------------------------------------------------------------------
//
// `suspended` is the run's NORMAL resting state while a remote step is in flight (the engine holds
// nothing in memory; it's durably parked awaiting the worker's result). It is ALSO the only symptom a
// lost dispatch ever produces: a worker claims a job and then dies (or the transport drops it) with no
// result ever coming back, and nothing auto-redrives it — `redispatchPending`'s own doc says as much.
// A healthy in-flight run and a stranded one are byte-identical in `status`; the only thing that
// distinguishes them is TIME: how long the run's been sitting there, and how long its oldest pending
// REMOTE checkpoint has been unresolved. This section surfaces that so `durable:runs` stops lying by
// omission about four-hour-old "suspended" runs looking exactly as fine as four-second-old ones.

/** The oldest unresolved REMOTE checkpoint of a run — the stranded-dispatch signature when it's old. */
export interface StalePendingStep {
  seq: number;
  name: string;
  /** How many times this step has been (re-)dispatched. A lost dispatch typically sits at 1 forever. */
  attempts: number;
  /** Milliseconds since the step was enqueued to the transport. */
  ageMs: number;
  /** Milliseconds since the worker's last persisted heartbeat for this step, or `null` when the
   *  handler never beat (see `StepCheckpoint.lastHeartbeatAt`). THE disambiguator for a long pending
   *  step: old + beating = alive mid-flight; old + silent = hung or lost. */
  heartbeatAgeMs: number | null;
}

/** A run plus the liveness signals that tell "working" apart from "stranded" (see module doc above). */
export interface RunLiveness {
  run: WorkflowRun;
  /** Milliseconds since `run.updatedAt`. */
  ageMs: number;
  /** `run.recoveryAttempts`, defaulted to 0 for display convenience. */
  recoveryAttempts: number;
  /** Oldest pending remote checkpoint, only computed for `running`/`suspended` runs — every other
   *  status either has none in flight or is terminal. `null` when there is none. */
  stalePending: StalePendingStep | null;
}

/** Default `--stale` threshold: a remote step pending this long is treated as "probably stranded". */
export const DEFAULT_STALE_MS = 15 * 60_000;

/** Find the oldest `pending` REMOTE checkpoint of a run, if any — the one data point that separates a
 *  run mid-step from a run whose dispatch was lost. */
async function oldestPendingRemoteStep(
  source: RunLister,
  runId: string,
  now: number,
): Promise<StalePendingStep | null> {
  const checkpoints = await source.listCheckpoints(runId);
  let oldest: StepCheckpoint | undefined;
  for (const cp of checkpoints) {
    if (cp.kind !== 'remote' || cp.status !== 'pending') continue;
    if (!oldest || cp.enqueuedAt.getTime() < oldest.enqueuedAt.getTime()) oldest = cp;
  }
  if (!oldest) return null;
  return {
    seq: oldest.seq,
    name: oldest.name,
    attempts: oldest.attempts,
    ageMs: now - oldest.enqueuedAt.getTime(),
    heartbeatAgeMs: oldest.lastHeartbeatAt ? now - oldest.lastHeartbeatAt.getTime() : null,
  };
}

/**
 * Attach liveness signals to a list of runs. Issues one `listCheckpoints` per `running`/`suspended`
 * run (bounded by the caller's `limit` — this is a CLI/dashboard read, not a hot path) so the listing
 * can show the age of an in-flight run's oldest pending remote step, not just its own `updatedAt`.
 */
export async function attachLiveness(
  source: RunLister,
  runs: WorkflowRun[],
  now: number = Date.now(),
): Promise<RunLiveness[]> {
  return Promise.all(
    runs.map(async (run) => {
      const stalePending =
        run.status === 'running' || run.status === 'suspended'
          ? await oldestPendingRemoteStep(source, run.id, now)
          : null;
      return {
        run,
        ageMs: now - run.updatedAt.getTime(),
        recoveryAttempts: run.recoveryAttempts ?? 0,
        stalePending,
      };
    }),
  );
}

/** Keep only runs whose oldest pending remote step has been unresolved for at least `thresholdMs` —
 *  the "these are probably stranded" view behind `--stale`. A step whose worker heartbeat is
 *  YOUNGER than the threshold is excluded however old the step is: a beating worker is mid-flight
 *  (a 40-minute browser batch is working, not stranded), and re-driving it would double-run it. */
export function filterStale(
  liveRuns: RunLiveness[],
  thresholdMs: number = DEFAULT_STALE_MS,
): RunLiveness[] {
  return liveRuns.filter(
    (rl) =>
      rl.stalePending !== null &&
      rl.stalePending.ageMs >= thresholdMs &&
      (rl.stalePending.heartbeatAgeMs === null || rl.stalePending.heartbeatAgeMs >= thresholdMs),
  );
}

/** Parse a compact single-unit duration (`90s`, `15m`, `4h`, `2d`) into milliseconds. Returns
 *  `undefined` for anything else so a fat-fingered `--stale=15mins` in an ops one-liner falls back to
 *  the default threshold instead of throwing. */
export function parseDurationMs(input: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return value * multiplier;
}

/** An actionable hint for an operator looking at a stranded run — the two recovery paths that
 *  actually exist for a lost dispatch (see `redispatchPending`'s own doc: no automatic recovery
 *  re-drives one). */
export function staleHint(runId: string): string {
  return (
    `Run ${runId} looks stranded (pending remote step exceeds the threshold). Recover it with ` +
    `\`engine.redispatchPending('${runId}')\` or \`node ace durable:retry ${runId}\`.`
  );
}

/** Render a runs list as a plain-text table for the terminal. Additive over the original
 *  RUN/WORKFLOW/STATUS/UPDATED columns: RECOVERY (blank unless `recoveryAttempts > 0`) and PENDING
 *  (the age + attempts of the oldest pending remote checkpoint, blank outside running/suspended or when
 *  there is none) — see the liveness module doc above for why these matter. */
export function renderRunsTable(liveRuns: RunLiveness[]): string {
  if (liveRuns.length === 0) return 'No runs.';
  const rows = liveRuns.map(({ run, ageMs, recoveryAttempts, stalePending }) => [
    run.id,
    run.workflow,
    run.status,
    compactAge(ageMs),
    recoveryAttempts > 0 ? String(recoveryAttempts) : '-',
    stalePending
      ? `${compactAge(stalePending.ageMs)} (attempt ${stalePending.attempts}${
          stalePending.heartbeatAgeMs !== null
            ? `, hb ${compactAge(stalePending.heartbeatAgeMs)}`
            : ''
        })`
      : '-',
  ]);
  return table(['RUN', 'WORKFLOW', 'STATUS', 'UPDATED', 'RECOVERY', 'PENDING'], rows);
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

/** Compact duration for the liveness columns, e.g. `4h32m`, `12m3s`, `45s`, `2d6h` — denser than a
 *  `"4h ago"` phrase so it stays readable next to the RECOVERY/PENDING columns. */
function compactAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

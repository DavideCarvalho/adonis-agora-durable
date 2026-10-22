import type {
  RunFacetQuery,
  RunStatus,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  RunWaiting,
  SignalWaiter,
  WorkflowRun,
} from './interfaces.js';
import { indexWaitersByRun, resolveRunWaiting } from './run-waiting.js';

/**
 * One `(status, origin)` cell of {@link runFacetsOf}: how many of the matching runs are in `status`
 * and carry `origin` (`null` for runs with none). A console pivots these into its status and origin
 * chips, so both stay exact while the list itself is paginated. Zero-count cells are absent.
 * Byte-compatible with aviary's `RunFacetRow`.
 */
export interface RunFacetRow {
  status: RunStatus;
  origin: string | null;
  count: number;
}

/** The value-enumeration read {@link runFacetsOf} is built on (an engine, or a gateway). */
export interface RunFacetSource {
  runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]>;
}

/** Origins counted one by one before the rest fold into the `null` bucket. */
const ORIGIN_LIMIT = 1_000;

/**
 * Counts of the runs matching `query` grouped by `(status, origin)`, from the status axis
 * enumerated once overall and once per named origin: the `null` bucket is the overall count less
 * every named origin's. Exact on a store whose `runValueFacets` groups in SQL (the column axes do);
 * one query per distinct origin, and origins are few (one per declaring package).
 */
export async function runFacetsOf(
  source: RunFacetSource,
  query: RunFacetQuery,
): Promise<RunFacetRow[]> {
  const opts: RunValueFacetOptions = { limit: ORIGIN_LIMIT };
  const [all, origins] = await Promise.all([
    source.runValueFacets({ field: 'status' }, query, opts),
    source.runValueFacets({ field: 'origin' }, query, opts),
  ]);
  const rest = new Map<string, number>();
  for (const row of all) if (row.value !== null) rest.set(row.value, row.count);
  const cells: RunFacetRow[] = [];
  for (const { value: origin } of origins) {
    if (origin === null) continue;
    const rows = await source.runValueFacets({ field: 'status' }, { ...query, origin }, opts);
    for (const row of rows) {
      if (row.value === null || row.count === 0) continue;
      cells.push({ status: row.value as RunStatus, origin, count: row.count });
      rest.set(row.value, (rest.get(row.value) ?? 0) - row.count);
    }
  }
  for (const [status, count] of rest) {
    if (count > 0) cells.push({ status: status as RunStatus, origin: null, count });
  }
  return cells;
}

/** The reads {@link waitingForRuns} needs. */
export interface WaitingSource {
  getRun(runId: string): Promise<WorkflowRun | null>;
  listSignalWaitersByRunIds(runIds: string[]): Promise<SignalWaiter[]>;
}

/**
 * What each of `runIds` is parked on, for the ones currently `suspended` on a signal, webhook,
 * awaited child or breakpoint. An unknown id, a run that is not suspended, and a suspension on
 * something else (a bare sleep, an in-flight step) are simply absent. A `Record` so it crosses the
 * P4 wire as plain JSON. Reads one run per waiting id, never per requested id.
 */
export async function waitingForRuns(
  source: WaitingSource,
  runIds: readonly string[],
): Promise<Record<string, RunWaiting>> {
  const byRun = indexWaitersByRun(await source.listSignalWaitersByRunIds([...new Set(runIds)]));
  const out: Record<string, RunWaiting> = {};
  await Promise.all(
    [...byRun.keys()].map(async (runId) => {
      const run = await source.getRun(runId);
      const waiting = run ? resolveRunWaiting(run, byRun) : undefined;
      if (waiting) out[runId] = waiting;
    }),
  );
  return out;
}

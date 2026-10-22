import type {
  RunFacetQuery,
  RunFacetRow,
  RunQuery,
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
 * The origin a facet cell is filed under. An origin that is absent, null, or blank is all the same
 * thing to an operator — a run no package claims — so they collapse to `null` here.
 */
export function facetOrigin(origin: string | null | undefined): string | null {
  return origin?.trim() ? origin : null;
}

/**
 * Fold `(status, origin)` counts into one cell per pair, normalising origins via {@link facetOrigin}.
 * Stores group in SQL and pipe their rows through this, so every store agrees on what lands in the
 * unattributed bucket.
 */
export function mergeRunFacetRows(
  rows: readonly { status: RunStatus; origin: string | null | undefined; count: number }[],
): RunFacetRow[] {
  const cells = new Map<string, RunFacetRow>();
  for (const row of rows) {
    if (!(row.count > 0)) continue;
    const origin = facetOrigin(row.origin);
    const key = JSON.stringify([row.status, origin]);
    const cell = cells.get(key);
    if (cell) cell.count += row.count;
    else cells.set(key, { status: row.status, origin, count: row.count });
  }
  return [...cells.values()];
}

/**
 * The reads {@link runFacetsOf} can be built on — a `StateStore`, an engine, or a gateway. Each is
 * optional; the best one present wins:
 * 1. `runFacets` — the native one-`GROUP BY` count (`StateStore.runFacets` / `engine.runFacets`);
 * 2. `runValueFacets` — the status axis enumerated once overall and once per named origin;
 * 3. `listRuns` — every matching run counted in process (correct, but it reads them all).
 */
export interface RunFacetSource {
  runFacets?(query: RunFacetQuery): Promise<RunFacetRow[]>;
  runValueFacets?(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]>;
  listRuns?(query: RunQuery): Promise<WorkflowRun[]>;
}

/** Origins counted one by one before the rest fold into the `null` bucket. */
const ORIGIN_LIMIT = 1_000;

/**
 * Counts of the runs matching `query` grouped by `(status, origin)` — one cell per pair, zero-count
 * cells absent, `null` for runs with no (or a blank) origin. Byte-compatible with aviary's
 * `RunFacetRow`. Uses the best read `source` offers (see {@link RunFacetSource}); a source with none
 * of them yields no cells.
 */
export async function runFacetsOf(
  source: RunFacetSource,
  query: RunFacetQuery,
): Promise<RunFacetRow[]> {
  if (source.runFacets) return source.runFacets(query);
  const valueFacets = source.runValueFacets;
  if (valueFacets) {
    return runFacetsFromValueFacets(
      (axis, q, opts) => valueFacets.call(source, axis, q, opts),
      query,
    );
  }
  if (source.listRuns) {
    const runs = await source.listRuns(query);
    return mergeRunFacetRows(
      runs.map((run) => ({ status: run.status, origin: run.origin, count: 1 })),
    );
  }
  return [];
}

/**
 * The status axis enumerated once overall and once per named origin: the `null` bucket is the overall
 * count less every named origin's. Exact on a store whose `runValueFacets` groups in SQL (the column
 * axes do); one query per distinct origin, and origins are few (one per declaring package).
 */
async function runFacetsFromValueFacets(
  runValueFacets: NonNullable<RunFacetSource['runValueFacets']>,
  query: RunFacetQuery,
): Promise<RunFacetRow[]> {
  const opts: RunValueFacetOptions = { limit: ORIGIN_LIMIT };
  const [all, origins] = await Promise.all([
    runValueFacets({ field: 'status' }, query, opts),
    runValueFacets({ field: 'origin' }, query, opts),
  ]);
  const rest = new Map<string, number>();
  for (const row of all) if (row.value !== null) rest.set(row.value, row.count);
  const cells: RunFacetRow[] = [];
  for (const { value: origin } of origins) {
    if (origin === null || !origin.trim()) continue;
    const rows = await runValueFacets({ field: 'status' }, { ...query, origin }, opts);
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

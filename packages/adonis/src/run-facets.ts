import type { RunFacetQuery, RunFacetRow, RunStatus, StateStore } from './interfaces.js';

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
 * {@link StateStore.runFacets} when the store has it, else the same cells counted over a
 * {@link StateStore.listRuns} result — correct, but it reads every matching run.
 */
export async function runFacetsOf(store: StateStore, query: RunFacetQuery): Promise<RunFacetRow[]> {
  if (store.runFacets) return store.runFacets(query);
  const runs = await store.listRuns(query);
  return mergeRunFacetRows(
    runs.map((run) => ({ status: run.status, origin: run.origin, count: 1 })),
  );
}

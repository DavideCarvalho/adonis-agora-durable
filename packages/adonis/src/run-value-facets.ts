import type {
  RunQuery,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  StateStore,
  WorkflowRun,
} from './interfaces.js';

/** Rows a value picker gets when the caller names no bound — enough to fill a dropdown several times
 *  over, small enough that an axis with unbounded cardinality (tags) can't return a listing. */
export const RUN_VALUE_FACET_LIMIT = 100;

/** Runs read when an axis has to be counted in-process (see {@link RunValueFacetOptions.scan}). */
export const RUN_VALUE_FACET_SCAN = 5000;

/**
 * Tag prefixes the ENGINE mints one of PER KEY — `singleton:<key>` is stamped on runs of a
 * singleton workflow so the admission gate can find its siblings.
 *
 * A picker ranks these last. They are machine bookkeeping with cardinality that grows with the data,
 * and on a real deployment they crowd out everything an operator would actually choose. Ranked, not
 * REMOVED: a singleton tag is still a legitimate thing to filter by (a run row's tag chip sets
 * exactly that), so it stays offered — just after the tags a human wrote.
 */
export const ENGINE_MINTED_TAG_PREFIXES = ['singleton:'] as const;

/** Is this a tag the engine mints one of per key? See {@link ENGINE_MINTED_TAG_PREFIXES}. */
export function isEngineMintedTag(value: string | null): boolean {
  return value !== null && ENGINE_MINTED_TAG_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Is this axis a plain column on the runs table, and so countable with a `GROUP BY` over the whole
 * matching set?
 *
 * The other two are not: the value isn't in a column of the row being counted. A run's tags live
 * inside ONE json array column, and its search attributes in a side table — so a store either writes
 * that expansion SQL or counts them in-process over a bounded scan
 * ({@link runValueFacetsFromRuns}), where the counts describe that window rather than the whole
 * store.
 */
export function axisIsRunColumn(
  axis: RunValueAxis,
): axis is { field: 'workflow' | 'status' | 'namespace' } {
  return axis.field === 'workflow' || axis.field === 'status' || axis.field === 'namespace';
}

/** The values one run contributes to an axis — several for `tag` (a run carries a set), one for the
 *  column axes, and none when the run has nothing on that axis (an absent search-attribute key). */
function valuesOf(run: WorkflowRun, axis: RunValueAxis): Array<string | null> {
  switch (axis.field) {
    case 'workflow':
      return [run.workflow];
    case 'status':
      return [run.status];
    case 'namespace':
      return run.namespace === undefined ? [] : [run.namespace];
    case 'tag':
      return run.tags ?? [];
    case 'attributeKey':
      return Object.keys(run.searchAttributes ?? {});
    case 'attributeValue': {
      const value = run.searchAttributes?.[axis.key];
      return value === undefined ? [] : [String(value)];
    }
  }
}

/**
 * Fold, order, search and bound raw `(value, count)` rows into the answer callers see: highest count
 * first, ties broken alphabetically so a picker's order is stable between polls (and therefore
 * pageable), and one `limit`-sized page from `offset`.
 *
 * Every store pipes its `GROUP BY` through this — so a picker lists the same values in the same order
 * whichever adapter is underneath, rather than each SQL dialect's default ordering leaking into the UI.
 */
export function mergeRunValueFacetRows(
  rows: readonly { value: string | null | undefined; count: number }[],
  opts?: RunValueFacetOptions,
): RunValueFacetRow[] {
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    const value = row.value ?? null;
    counts.set(value, (counts.get(value) ?? 0) + Number(row.count));
  }
  const needle = opts?.search?.trim().toLowerCase();
  const merged = [...counts]
    .map(([value, count]) => ({ value, count }))
    .filter((row) => row.count > 0)
    // Applied here rather than by the caller so every store searches identically — and before the
    // bound, so a match outside the top slice is still reachable, which is the whole point of a
    // search box on a list that was cut to fit.
    .filter((row) => !needle || row.value?.toLowerCase().includes(needle))
    .sort((a, b) => {
      // Engine-minted per-key tags rank after everything else, however common they are — see
      // ENGINE_MINTED_TAG_PREFIXES for what they otherwise do to a picker.
      const engineA = isEngineMintedTag(a.value);
      const engineB = isEngineMintedTag(b.value);
      if (engineA !== engineB) return engineA ? 1 : -1;
      if (b.count !== a.count) return b.count - a.count;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return a.value.localeCompare(b.value);
    });
  const offset = opts?.offset ?? 0;
  return merged.slice(offset, offset + (opts?.limit ?? RUN_VALUE_FACET_LIMIT));
}

/**
 * Count an axis's distinct values across runs already narrowed by the caller's predicates — the
 * in-process path, used for every axis a store cannot `GROUP BY`. `runs` must be ordered
 * newest-first and already bounded to {@link RunValueFacetOptions.scan}, since that window is what
 * the counts then describe.
 */
export function runValueFacetsFromRuns(
  runs: readonly WorkflowRun[],
  axis: RunValueAxis,
  opts?: RunValueFacetOptions,
): RunValueFacetRow[] {
  const rows: { value: string | null; count: number }[] = [];
  for (const run of runs) {
    for (const value of valuesOf(run, axis)) rows.push({ value, count: 1 });
  }
  return mergeRunValueFacetRows(rows, opts);
}

/**
 * The scan fallback for a store without a native {@link StateStore.runValueFacets}: read the newest
 * `scan` runs matching `query` through {@link StateStore.listRuns} and count the axis in-process.
 * `listRuns` narrows the window; {@link runValueFacetsFromRuns} counts it. The counts describe that
 * window rather than the whole store — bounded and deliberately approximate, where the alternative
 * is a full scan on every keystroke.
 */
export async function scanRunValueFacets(
  store: Pick<StateStore, 'listRuns'>,
  axis: RunValueAxis,
  query: RunQuery,
  opts?: RunValueFacetOptions,
): Promise<RunValueFacetRow[]> {
  const scan = opts?.scan ?? RUN_VALUE_FACET_SCAN;
  const runs = await store.listRuns({ ...query, limit: scan, offset: 0 });
  return runValueFacetsFromRuns(runs, axis, opts);
}

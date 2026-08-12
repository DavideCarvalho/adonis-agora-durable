import type { WorkflowRun } from './durable-client.js';

/**
 * Which package's code produced a run — the `WorkflowRun.origin` axis, as the facet an operator
 * picks in the console.
 *
 * Three cases, and the third is why this is a union instead of a plain `string | undefined`:
 *
 *  - `all` — the DEFAULT. Every origin, attributed or not. Core's `RunQuery.origin` docblock is
 *    explicit that a facet built on it must keep this option, because an exact-match origin filter
 *    hides every unattributed run.
 *  - `origin` — one concrete package (`@adonis-agora/catalog-pipeline`).
 *  - `unknown` — runs with NO recorded origin. `RunQuery.origin` is an exact-match string and so
 *    cannot express "absent", which is exactly why this case is applied here, over the run list the
 *    console already holds, instead of being pushed down to the store.
 */
export type OriginFilter =
  | { kind: 'all' }
  | { kind: 'unknown' }
  | { kind: 'origin'; origin: string };

/** The default facet: every origin, including runs that carry none. */
export const ALL_ORIGINS: OriginFilter = { kind: 'all' };

/** How an absent origin is spelled in the UI. Never "app", never blank — see {@link originLabel}. */
export const UNKNOWN_ORIGIN = 'unknown';

/**
 * The run's origin if it has a usable one, else `undefined` — the single place "unknown" is decided.
 *
 * `undefined` is the shape core documents (a run created before the field existed, a registration
 * path that carries no origin, or a package that could not be resolved with confidence); a blank or
 * whitespace-only string folds in here too, because a store column that defaults to `''` instead of
 * NULL would otherwise read as a real package whose name is nothing.
 */
export function knownOrigin(origin: string | undefined): string | undefined {
  const trimmed = origin?.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether a run carries no usable origin — UNKNOWN. See {@link knownOrigin}. */
export function isUnknownOrigin(origin: string | undefined): boolean {
  return knownOrigin(origin) === undefined;
}

/**
 * Short display label for an origin: the package name without its npm scope
 * (`@adonis-agora/catalog-pipeline` → `catalog-pipeline`), so a sidebar chip is readable at
 * 10px. Every call site pairs it with the FULL string as a `title`, so nothing is lost. An absent
 * origin renders as {@link UNKNOWN_ORIGIN} — an operator must be able to see that a run is
 * unattributed, and folding it into a real package name would be a lie.
 */
export function originLabel(origin: string | undefined): string {
  const known = knownOrigin(origin);
  if (known === undefined) return UNKNOWN_ORIGIN;
  const slash = known.lastIndexOf('/');
  if (slash === -1) return known;
  // `@scope/` with nothing after it isn't a package name we can shorten — keep it whole.
  return known.slice(slash + 1) || known;
}

/** Facet equality — the selected chip is found by value, not by identity. */
export function sameOriginFilter(a: OriginFilter, b: OriginFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'origin' && b.kind === 'origin') return a.origin === b.origin;
  return true;
}

/** A stable React key / test handle for a facet (`origin:@scope/pkg`, `all`, `unknown`). */
export function originFilterKey(filter: OriginFilter): string {
  return filter.kind === 'origin' ? `origin:${filter.origin}` : filter.kind;
}

/** Does this run belong to the selected facet? `all` matches everything, including unattributed runs. */
export function matchesOrigin(run: Pick<WorkflowRun, 'origin'>, filter: OriginFilter): boolean {
  if (filter.kind === 'all') return true;
  const known = knownOrigin(run.origin);
  if (filter.kind === 'unknown') return known === undefined;
  return known === filter.origin;
}

/** The runs in the selected facet, in their existing order. */
export function filterByOrigin<T extends Pick<WorkflowRun, 'origin'>>(
  runs: readonly T[],
  filter: OriginFilter,
): T[] {
  return filter.kind === 'all' ? [...runs] : runs.filter((r) => matchesOrigin(r, filter));
}

/** One selectable origin chip: what to show, what it means, and how many runs it covers. */
export interface OriginFacet {
  filter: OriginFilter;
  /** Short chip text — the scope-less package name, `all`, or `unknown`. */
  label: string;
  /** Full text for the chip's `title`: the unabbreviated package, or what unknown actually means. */
  title: string;
  count: number;
}

/** What the `unknown` chip's tooltip says — the one place the absent case is explained in prose. */
export const UNKNOWN_ORIGIN_TITLE =
  'Runs with no recorded origin: started before origins were stamped, or registered through a path whose declaring package could not be resolved. Not attributed to any library.';

/**
 * The origin chips for a run list: `all` first, then every attributed package (alphabetical), then
 * `unknown` LAST and only when there is something in it.
 *
 * Counted over the runs the console currently holds, the same way the header's status chips are — so
 * the counts and the list always agree, and (unlike a store-side facet) the unattributed bucket stays
 * visible and countable while a package is selected.
 */
export function originFacets(runs: readonly Pick<WorkflowRun, 'origin'>[]): OriginFacet[] {
  const known = new Map<string, number>();
  let unknown = 0;
  for (const run of runs) {
    const origin = knownOrigin(run.origin);
    if (origin === undefined) {
      unknown += 1;
      continue;
    }
    known.set(origin, (known.get(origin) ?? 0) + 1);
  }
  const facets: OriginFacet[] = [
    {
      filter: ALL_ORIGINS,
      label: 'all',
      title: 'Every origin, including runs that have none',
      count: runs.length,
    },
  ];
  for (const origin of [...known.keys()].sort()) {
    facets.push({
      filter: { kind: 'origin', origin },
      label: originLabel(origin),
      title: origin,
      count: known.get(origin) ?? 0,
    });
  }
  if (unknown > 0) {
    facets.push({
      filter: { kind: 'unknown' },
      label: UNKNOWN_ORIGIN,
      title: UNKNOWN_ORIGIN_TITLE,
      count: unknown,
    });
  }
  return facets;
}

/** How many of these runs carry no origin — the size of the unattributed bucket. */
export function unknownOriginCount(runs: readonly Pick<WorkflowRun, 'origin'>[]): number {
  return runs.reduce((n, r) => n + (isUnknownOrigin(r.origin) ? 1 : 0), 0);
}

/** What an empty run list should say, and whether to offer a jump to the unattributed runs. */
export interface EmptyRunsNotice {
  message: string;
  /** When set, the list offers "show unclassified" — this many runs carry no origin. */
  unclassified?: number;
}

/**
 * Why the list is empty, in the operator's terms.
 *
 * The case this exists for: an operator filters by a package, sees nothing, and cannot tell "no run
 * matched" from "these runs are unattributable, and an exact-match origin filter can never match
 * them". So a package filter that comes back empty NAMES the unattributed bucket and offers to open
 * it, and an empty `unknown` facet says in words that everything here is attributed rather than
 * looking like a filter that swallowed the runs.
 *
 * `unknownCount` is counted over the runs BEFORE the origin facet is applied — otherwise it would be
 * zero in exactly the case it exists for.
 */
export function emptyRunsNotice(opts: {
  /** Whether any filter at all (status, tag, attrs, namespace, origin) is narrowing the list. */
  anyFilter: boolean;
  origin: OriginFilter;
  unknownCount: number;
}): EmptyRunsNotice {
  if (!opts.anyFilter) return { message: 'No runs yet.' };
  if (opts.origin.kind === 'unknown') {
    return {
      message:
        opts.unknownCount > 0
          ? 'No unclassified runs match the other filters.'
          : 'Every run here has a recorded origin — none are unclassified.',
    };
  }
  if (opts.origin.kind === 'origin' && opts.unknownCount > 0) {
    return {
      message: `No runs from ${originLabel(opts.origin.origin)} match these filters.`,
      unclassified: opts.unknownCount,
    };
  }
  return { message: 'No runs match these filters.' };
}

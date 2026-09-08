import type { RunQuery } from './interfaces.js';

/**
 * The offset window a {@link RunQuery}'s `page`/`size` resolves to — what a store actually spends
 * on `LIMIT`/`OFFSET` (or an array slice).
 *
 * `limit` is `undefined` when the query asked for no window at all, which means "every matching
 * run": a store must then apply no bound rather than defaulting to one, or an engine-internal scan
 * (`listIncompleteRuns`-style sweeps, the singleton admission count) would silently truncate.
 */
export interface RunPageWindow {
  /** Rows to return, or `undefined` for "no bound". */
  limit: number | undefined;
  /** Rows to skip — `(page - 1) * size`, and always `0` when there is no bound. */
  offset: number;
}

/**
 * Resolve a {@link RunQuery}'s 1-based `page`/`size` into the 0-based window a store executes.
 *
 * This is the ONE place the 0-based offset is computed. The public shape (the `RunQuery` a caller
 * builds, the `?page=&size=` an endpoint parses) is 1-based page + page size — the ecosystem's
 * pagination interface, shared with `@adonis-agora/filter` — and the offset stays an internal
 * detail of whatever engine or store is being driven. Exported because a third-party
 * {@link StateStore} implements `listRuns` itself and needs the same arithmetic to agree with the
 * built-in adapters (the conformance kit asserts it does).
 *
 * A `page` without a `size` is ignored: with no bound there is exactly one page, so a page number
 * has nothing to offset against. `page` below `1` clamps to the first page (a 0-based caller
 * ported from the old `offset` spelling reads page one, never a negative offset).
 */
export function runPageWindow(query: Pick<RunQuery, 'page' | 'size'>): RunPageWindow {
  const size = query.size;
  if (size === undefined || !Number.isFinite(size) || size < 0) {
    return { limit: undefined, offset: 0 };
  }
  const bound = Math.trunc(size);
  const page = Math.max(1, Math.trunc(query.page ?? 1) || 1);
  return { limit: bound, offset: (page - 1) * bound };
}

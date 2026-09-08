import type { ResolvedPagination } from '@adonis-agora/filter';
import { describe, expect, it } from 'vitest';
import type { RunQuery } from '../../src/interfaces.js';
import { runPageWindow } from '../../src/run-pagination.js';

/** The paging half of a {@link RunQuery} — what this file pins against the filter lib's shape. */
type RunPaging = Pick<RunQuery, 'page' | 'size'>;

/** Compile-time equality: invariant BOTH ways, so a rename or a retype on either side fails here. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * `RunQuery`'s paging is declared locally rather than imported from `@adonis-agora/filter`
 * (`interfaces.ts` is the core engine contract, implemented by stores with no filter — and no
 * Lucid — dependency, while filter's barrel re-exports Lucid-typed members). These assertions are
 * what keeps "declared locally" from meaning "free to drift": they live in the dashboard layer,
 * the one place that already depends on filter for real, and they fail to COMPILE the moment the
 * two shapes stop matching.
 */
describe('run paging is structurally @adonis-agora/filter’s offset pagination', () => {
  it('takes filter’s ResolvedPagination verbatim as a RunQuery page window', () => {
    const fromFilter: ResolvedPagination = { page: 2, size: 25 };
    // Compiles only while the two shapes agree — a resolved filter pagination IS a run page window.
    const asRunQuery: RunPaging = fromFilter;

    expect(asRunQuery).toEqual({ page: 2, size: 25 });
  });

  it('names the same fields, with the same value types, as ResolvedPagination', () => {
    // The reverse assignment does NOT hold under `exactOptionalPropertyTypes`: filter's fields are
    // REQUIRED (it is the *resolved* pagination) while a `RunQuery`'s are optional `| undefined` —
    // a query with no window is a legitimate query. That mismatch is a second reason the type is
    // declared locally instead of aliased to `Partial<ResolvedPagination>`; what has to stay true
    // is the field names and their value types, asserted invariantly here.
    const sameKeys: Exact<keyof RunPaging, keyof ResolvedPagination> = true;
    const samePage: Exact<NonNullable<RunPaging['page']>, ResolvedPagination['page']> = true;
    const sameSize: Exact<NonNullable<RunPaging['size']>, ResolvedPagination['size']> = true;

    expect([sameKeys, samePage, sameSize]).toEqual([true, true, true]);
  });

  it('resolves the 1-based page/size to the 0-based window a store executes', () => {
    expect(runPageWindow({ page: 1, size: 25 })).toEqual({ limit: 25, offset: 0 });
    expect(runPageWindow({ page: 3, size: 25 })).toEqual({ limit: 25, offset: 50 });
    // `page` defaults to the first page.
    expect(runPageWindow({ size: 25 })).toEqual({ limit: 25, offset: 0 });
  });

  it('leaves an unbounded query unbounded — no size means no window, whatever the page', () => {
    expect(runPageWindow({})).toEqual({ limit: undefined, offset: 0 });
    // A page number with nothing to page through is not an offset: one page, no bound.
    expect(runPageWindow({ page: 4 })).toEqual({ limit: undefined, offset: 0 });
  });

  it('clamps a page below 1 to the first page instead of producing a negative offset', () => {
    expect(runPageWindow({ page: 0, size: 10 })).toEqual({ limit: 10, offset: 0 });
    expect(runPageWindow({ page: -3, size: 10 })).toEqual({ limit: 10, offset: 0 });
    expect(runPageWindow({ page: Number.NaN, size: 10 })).toEqual({ limit: 10, offset: 0 });
  });

  it('treats a nonsensical size as no bound rather than an empty listing', () => {
    expect(runPageWindow({ size: -1 })).toEqual({ limit: undefined, offset: 0 });
    expect(runPageWindow({ size: Number.NaN })).toEqual({ limit: undefined, offset: 0 });
    // Zero IS a meaningful bound (it was under `limit: 0` too): explicitly ask for nothing.
    expect(runPageWindow({ size: 0 })).toEqual({ limit: 0, offset: 0 });
  });
});

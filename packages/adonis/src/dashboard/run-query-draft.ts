import type { RunFacetQuery, RunQuery } from '../interfaces.js';

/**
 * What the dashboard's filter runner hands its filter in place of a query builder: a
 * {@link RunQuery} under construction.
 *
 * The runner never inspects it — it only passes it back to the filter's own methods — so the shape
 * is ours to choose, and a plain predicate bag is the honest one. There is no SQL to append to
 * here; a run query is a fixed set of named predicates that the engine resolves, so "building" it
 * is filling fields in, and everything the filter wire format can express but `RunQuery` cannot is
 * rejected at the point of translation rather than accumulated and silently dropped.
 */
export class RunQueryDraft {
  readonly query: RunQuery = {};

  /** Narrow by one or more predicates. Later calls overwrite the same field. */
  narrow(patch: RunQuery): void {
    Object.assign(this.query, patch);
  }

  /** Add one search-attribute predicate. These ACCUMULATE (unlike {@link narrow}) because
   *  `RunQuery.attributes` is an ANDed list — two predicates on different keys are both meant. */
  attribute(filter: NonNullable<RunQuery['attributes']>[number]): void {
    this.query.attributes = [...(this.query.attributes ?? []), filter];
  }

  /** The predicates minus the status axes — what `runValues` scopes its enumeration by, so the
   *  offered values don't collapse to the one status being viewed. */
  facetQuery(): RunFacetQuery {
    const { status, statuses, ...facetQuery } = this.query;
    return facetQuery;
  }
}

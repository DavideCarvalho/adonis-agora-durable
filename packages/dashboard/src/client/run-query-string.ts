import { FilterQueryBuilder } from '@adonis-agora/filter-client';
import type { RunStatus } from './durable-client.js';

/** The fields a value picker can enumerate. `attr` lists the search-attribute KEYS in use;
 *  `attr.<key>` lists the values recorded under one of them. */
export type RunValueField = 'workflow' | 'status' | 'namespace' | 'tag' | `attr.${string}` | 'attr';

/** One row of a value picker: a distinct value and how many matching runs carry it. */
export interface RunValueRow {
  value: string | null;
  count: number;
}

/**
 * Everything the console can narrow a run listing by. A scalar narrows to one value; an ARRAY
 * matches any of them, which is what a multi-select produces.
 */
export interface RunPredicates {
  status?: RunStatus | undefined;
  workflow?: string | string[] | undefined;
  tag?: string | string[] | undefined;
  namespace?: string | string[] | undefined;
  origin?: string | undefined;
  /** `key:op:value` predicates (`amount:gte:200`), or `key:in:a|b` for a set. */
  attr?: string[] | undefined;
}

/** The short attribute ops the console's predicates spell — validated here so a malformed
 *  predicate never leaves the client; the server parses the opaque string. */
const ATTR_SHORT_OPS: ReadonlySet<string> = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);

/** Narrow the builder by one axis: scalars narrow to one value, arrays match ANY of them. An empty
 *  selection is "no restriction", not "match nothing": the operator cleared the box. A blank param
 *  is what a cleared box sends; passing it through would be an exact match on a value nothing has. */
function narrow(
  builder: FilterQueryBuilder,
  field: string,
  value: string | string[] | undefined,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    builder.where(field, value.length === 1 ? value[0] : value);
    return;
  }
  if (value !== '') builder.where(field, value);
}

/**
 * The console's filter as a query string, built with `@adonis-agora/filter-client`.
 *
 * One builder for the listing, its value pickers and its bulk actions, so those three can never
 * disagree about what the operator selected — a bulk retry scoped more widely than the list it was
 * launched from acts on runs nobody looked at.
 *
 * Attribute predicates travel opaque (`attr=key:op:value`, one string or a list): attribute keys
 * are dynamic, so no envelope field could own them, and the one string carries key, operator and
 * operand through unchanged.
 */
export function runQueryString(
  predicates: RunPredicates,
  paginate: { page?: number | undefined; size?: number | undefined } = {},
  groupByCount?: { field: RunValueField; limit?: number; offset?: number; search?: string },
): string {
  // The class, not the `filterQuery()` factory: the console owns query-building (predicates,
  // paging, the values-picker envelope) and extends it below, so it holds the builder directly.
  const builder = new FilterQueryBuilder();

  narrow(builder, 'status', predicates.status);
  narrow(builder, 'workflow', predicates.workflow);
  narrow(builder, 'tag', predicates.tag);
  narrow(builder, 'namespace', predicates.namespace);
  // The engine has no `origin` column — the server reads but ignores it — so sending it keeps a
  // hand-built URL and the console's requests spelling the filter the same way.
  if (predicates.origin) builder.where('origin', predicates.origin);

  const attrPredicates: string[] = [];
  for (const entry of predicates.attr ?? []) {
    // Opaque `key:op:value` strings: attribute keys are dynamic, so no envelope field could own
    // them — the server's `attr` method parses the strings. A colon in the value is preserved
    // (only the first two colons delimit); malformed entries never leave the client.
    const [key, op, ...rest] = entry.split(':');
    if (!key || !ATTR_SHORT_OPS.has(op ?? '') || rest.length === 0) continue;
    attrPredicates.push(entry);
  }
  if (attrPredicates.length > 0) {
    builder.where('attr', attrPredicates.length === 1 ? attrPredicates[0] : attrPredicates);
  }

  // Offset paging as the ecosystem spells it: a 1-based `page` and a `size`, flat on the wire
  // (`?page=2&size=100`) — the same shape `@adonis-agora/filter` parses into `FilterInput.page`/
  // `.size`. Sent through `set()` rather than the builder's `page(page, size)` helper so a caller
  // that names only one of the two doesn't get the helper's own `size` default (25) invented
  // underneath it — the server owns that default (50), and it must stay the one that applies.
  if (paginate.page !== undefined) builder.set('page', paginate.page);
  if (paginate.size !== undefined) builder.set('size', paginate.size);

  // The values-picker envelope rides the same builder: the scope above plus the axis it
  // enumerates. `limit`/`offset`/`search` here bound the offered VALUES, not the run list — that
  // is filter's own group-by-count shape, deliberately left as-is while the run listing moved to
  // `page`/`size`. The two never mix because a values call never sends a page window (and vice
  // versa).
  if (groupByCount) {
    builder.groupByCount(groupByCount.field, {
      ...(groupByCount.limit !== undefined && { limit: groupByCount.limit }),
      ...(groupByCount.offset !== undefined && { offset: groupByCount.offset }),
      ...(groupByCount.search?.trim() && { search: groupByCount.search.trim() }),
    });
  }

  return builder.toQueryString();
}

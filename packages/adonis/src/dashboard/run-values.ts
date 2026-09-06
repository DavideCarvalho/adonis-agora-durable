import type { GroupByCountAdapter } from '@adonis-agora/filter';
import { InvalidColumnFilterError } from '@adonis-agora/filter';
import type { RunValueAxis } from '../interfaces.js';
import { RUN_VALUE_FACET_LIMIT, scanRunValueFacets } from '../run-value-facets.js';
import type { DashboardEngine } from './handlers.js';
import type { RunQueryDraft } from './run-query-draft.js';

/**
 * Map a picker's `field` to the {@link RunValueAxis} it enumerates, or `null` for a field with no
 * enumerable values. `attr` lists the search-attribute KEYS in use; `attr.<key>` lists the values
 * recorded under one of them.
 */
export function valueAxisFor(field: string | undefined): RunValueAxis | null {
  if (!field) return null;
  if (field === 'attr') return { field: 'attributeKey' };
  if (field.startsWith('attr.')) {
    const key = field.slice('attr.'.length);
    return key ? { field: 'attributeValue', key } : null;
  }
  if (field === 'workflow' || field === 'status' || field === 'namespace' || field === 'tag') {
    return { field };
  }
  return null;
}

/**
 * The console's value enumeration as a filter-lib adapter: the helper narrows the draft over the
 * scope, then this counts one axis over it — through the engine's native enumeration when the
 * port has it, else a bounded `listRuns` scan in-process (same shape, bounded approximation, so
 * store-less tenant pods serve pickers with no wire-protocol change).
 *
 * Status is dropped from the scope here (not in the filter class): the class answers "what runs
 * match", the axis answers "what values those runs take", and the offered values must not
 * collapse to the one status being viewed.
 */
export function runValueAdapter(engine: DashboardEngine): GroupByCountAdapter<RunQueryDraft> {
  return {
    groupByCount: async (field, draft, opts) => {
      const axis = valueAxisFor(field);
      if (!axis) {
        throw new InvalidColumnFilterError(
          'field must be one of workflow, status, namespace, tag, attr, attr.<key>',
        );
      }
      // One choke point for the bound: the console pages the offered values, and an unbounded
      // axis (tags) would return a listing rather than an aggregate.
      const limit = Math.min(opts.limit ?? RUN_VALUE_FACET_LIMIT, 200);
      const offset = Math.max(0, opts.offset ?? 0);
      const scope = draft.facetQuery();
      const bounded = { ...opts, limit, offset };
      const rows = engine.runValueFacets
        ? await engine.runValueFacets(axis, scope, bounded)
        : await scanRunValueFacets({ listRuns: (q) => engine.listRuns(q) }, axis, scope, bounded);
      return rows.map((row) => ({ value: row.value, count: row.count }));
    },
  };
}

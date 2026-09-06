import type {
  AttributeFilter,
  AttributeOp,
  AttributeValue,
  RunQuery,
  SearchAttributes,
  WorkflowRun,
} from './interfaces.js';

/** Compare one attribute value against a filter operand. Range ops need both sides comparable. */
function compare(
  actual: unknown,
  op: AttributeOp,
  expected: AttributeValue | AttributeValue[],
): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'gt':
      return actual != null && actual > (expected as AttributeValue);
    case 'gte':
      return actual != null && actual >= (expected as AttributeValue);
    case 'lt':
      return actual != null && actual < (expected as AttributeValue);
    case 'lte':
      return actual != null && actual <= (expected as AttributeValue);
    case 'in':
      return (
        Array.isArray(expected) &&
        expected.length > 0 &&
        (expected as AttributeValue[]).some((v) => actual === v)
      );
  }
}

/** The operand(s) one attribute predicate compares against — a singleton, or the `in` set. */
function operandsOf(f: AttributeFilter): AttributeValue | AttributeValue[] {
  return f.op === 'in' ? f.values : f.value;
}

/**
 * Does a run's search attributes satisfy EVERY filter (AND)? A missing key never matches (so `ne`
 * on an absent key is false too — the attribute simply isn't there to compare). Empty/undefined
 * filters match everything. Shared by every store so typed/range queries behave identically across
 * adapters (applied in-process after the coarse workflow/status/tag filters).
 */
export function matchesAttributes(
  attributes: SearchAttributes | undefined,
  filters: AttributeFilter[] | undefined,
): boolean {
  if (!filters?.length) return true;
  if (!attributes) return false;
  return filters.every(
    (f) => f.key in attributes && compare(attributes[f.key], f.op, operandsOf(f)),
  );
}

/**
 * Apply a query's attribute predicates then its `offset`/`limit`, in-process — for store adapters
 * that can't express typed/range predicates in SQL. Pass rows already coarse-filtered (workflow /
 * status / tag) and sorted newest-first; this filters by `attributes` and paginates. Only call it
 * when `query.attributes` is set (otherwise let the DB do `LIMIT`/`OFFSET`).
 */
export function applyAttributeQuery(rows: WorkflowRun[], query: RunQuery): WorkflowRun[] {
  const filtered = rows.filter((r) => matchesAttributes(r.searchAttributes, query.attributes));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? filtered.length;
  return filtered.slice(offset, offset + limit);
}

/**
 * One normalized row of the `durable_run_attributes` side-table: a single (key → value) pair of a
 * run's search attributes, split into typed columns so SQL can index/range-scan it. Exactly one of
 * `strValue`/`numValue` is set per row (booleans normalize to a string `"true"`/`"false"` so `eq`/`ne`
 * still match). NULL for the column that doesn't apply, which keeps `(key, numValue)` /
 * `(key, strValue)` indexes selective.
 */
export interface RunAttributeRow {
  runId: string;
  key: string;
  strValue: string | null;
  numValue: number | null;
}

/**
 * Explode a run's search attributes into normalized side-table rows (one per key). Used by SQL stores
 * to maintain `durable_run_attributes` on every create/update and by the in-memory store's index, so
 * attribute predicates can be pushed DOWN into a join/EXISTS instead of scanned in-process. Numbers go
 * to `numValue`; strings to `strValue`; booleans to `strValue` as `"true"`/`"false"` (matching how the
 * in-process `compare` treats `eq`/`ne` on booleans). Returns `[]` for a run with no attributes.
 */
export function normalizeAttributeRows(
  runId: string,
  attributes: SearchAttributes | undefined,
): RunAttributeRow[] {
  if (!attributes) return [];
  const out: RunAttributeRow[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'number') {
      out.push({ runId, key, strValue: null, numValue: value });
    } else if (typeof value === 'boolean') {
      out.push({ runId, key, strValue: value ? 'true' : 'false', numValue: null });
    } else {
      out.push({ runId, key, strValue: value, numValue: null });
    }
  }
  return out;
}

/** SQL comparison operator for an {@link AttributeOp} (used to build pushdown predicates). */
export function sqlComparator(op: AttributeOp): string {
  switch (op) {
    case 'eq':
    case 'in':
      return '=';
    case 'ne':
      return '<>';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
  }
}

/**
 * Which side-table column an attribute filter compares against: numeric operands (and range ops on
 * numbers) hit `numValue`; everything else hits `strValue` (booleans are stored as `"true"`/`"false"`).
 * For `in`, the column follows the set: all numbers hit `numValue`, anything else `strValue`.
 * Keeping this in core means every SQL adapter pushes predicates down identically.
 */
export function attributeColumnFor(filter: AttributeFilter): 'numValue' | 'strValue' {
  if (filter.op === 'in') {
    return filter.values.length > 0 && filter.values.every((v) => typeof v === 'number')
      ? 'numValue'
      : 'strValue';
  }
  return typeof filter.value === 'number' ? 'numValue' : 'strValue';
}

/** The literal a side-table predicate compares against (booleans → `"true"`/`"false"` strings). */
export function attributeOperand(filter: AttributeFilter): string | number {
  if (filter.op === 'in') {
    throw new Error('attributeOperand is scalar-only — use attributeOperands for an `in` filter');
  }
  if (typeof filter.value === 'boolean') return filter.value ? 'true' : 'false';
  return filter.value;
}

/** The literals an `in` side-table predicate matches against (same boolean normalization). */
export function attributeOperands(filter: AttributeFilter): Array<string | number> {
  const values = filter.op === 'in' ? filter.values : [filter.value];
  return values.map((v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : v));
}

import type { AttributeFilter, AttributeOp } from '../interfaces.js';

/**
 * Ported from `@dudousxd/nestjs-durable-dashboard`'s `attr-filter.ts` — parses the same
 * `attr=key:op:value` query convention so the dashboard's search-attribute filtering behaves
 * identically across both ecosystems.
 */

const ATTR_OPS = new Set<AttributeOp>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']);

/** Coerce a query-string value: `true`/`false` -> boolean, numeric -> number, else the raw string. */
export function coerceAttrValue(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/**
 * Parse `attr=key:op:value` query params (repeatable, ANDed) into {@link AttributeFilter}s — e.g.
 * `?attr=amount:gte:200&attr=tier:eq:pro`. `op` must be a known operator; a colon in the value is
 * preserved (only the first two colons delimit). `in` takes a `|`-separated set
 * (`?attr=tier:in:pro|enterprise`), matched as OR inside the one predicate. Malformed entries are
 * skipped.
 */
export function parseAttrFilters(attr?: unknown): AttributeFilter[] | undefined {
  if (!attr) return undefined;
  const raw = (Array.isArray(attr) ? attr : [attr]).filter(
    (entry): entry is string => typeof entry === 'string',
  );
  const filters: AttributeFilter[] = [];
  for (const entry of raw) {
    const [key, op, ...rest] = entry.split(':');
    if (!key || !ATTR_OPS.has(op as AttributeOp) || rest.length === 0) continue;
    if (op === 'in') {
      // An empty set matches nothing — but keep it as a real predicate (rather than dropping it)
      // so the caller filters to nothing instead of silently widening to everything.
      const values = rest
        .join(':')
        .split('|')
        .filter((part) => part !== '')
        .map(coerceAttrValue);
      filters.push({ key, op: 'in', values });
      continue;
    }
    filters.push({
      key,
      op: op as Exclude<AttributeOp, 'in'>,
      value: coerceAttrValue(rest.join(':')),
    });
  }
  return filters.length ? filters : undefined;
}

import { BaseFilter, InvalidColumnFilterError } from '@adonis-agora/filter';
import type { AttributeOp, RunStatus } from '../interfaces.js';
import { coerceAttrValue, parseAttrFilters } from './attr-filter.js';
import { RunQueryDraft } from './run-query-draft.js';

/** The full status union (`interfaces.ts`'s `RunStatus`) — kept in sync so filters never drop a
 *  state; a previous version of this list was missing `'blocked'`. */
export const RUN_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'dead',
];

/** A repeated query param arrives as an array and a single one as a scalar; both mean a list. An
 *  absent or blank entry is dropped rather than stringified: `?namespace=` is what a cleared
 *  filter box sends, and filtering for a tenant literally named "undefined" would silently empty
 *  the console. */
function list(value: unknown): string[] {
  return asList(value)
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map(String);
}

/**
 * Totuple `value` into a list. The query parser decodes `field[]=a…` past its item cap as a
 * numeric-keyed object instead of an array — same list either way, so a 21-tag multi-select keeps
 * working instead of collapsing to one opaque object entry.
 */
function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 0 && entries.every(([key]) => /^\d+$/.test(key))) {
      return entries.sort(([a], [b]) => Number(a) - Number(b)).map(([, entry]) => entry);
    }
  }
  return [value];
}

/** Validate that a string is a known {@link RunStatus}, else `undefined` — an unrecognised status
 *  is ignored, not rejected, so a newer console never 400s against an older server. */
function parseStatus(value: string | undefined): RunStatus | undefined {
  if (value && (RUN_STATUSES as readonly string[]).includes(value)) {
    return value as RunStatus;
  }
  return undefined;
}

/** Canonical filter-lib operators the structured attr spelling accepts, mapped to {@link AttributeOp}. */
const ATTR_OPERATORS: Record<string, AttributeOp> = {
  equals: 'eq',
  notEquals: 'ne',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  in: 'in',
  isAnyOf: 'in',
};

/** Operators a set-valued axis accepts: one value narrows, several match ANY of them. */
function assertSetOperator(axis: string, operator: string): void {
  if (operator !== 'equals' && operator !== 'in' && operator !== 'isAnyOf') {
    throw new InvalidColumnFilterError(`"${axis}" does not support the "${operator}" operator.`);
  }
}

/**
 * The console's run filter, as a class — one method per request key, narrowing a {@link RunQueryDraft}.
 *
 * This is the filter lib's unified class form (`BaseFilter`, shared with model filters) driven by
 * `applyCustomFilter` with a draft in place of a Lucid builder. Every predicate is reachable two
 * ways, and both are the same request to this class: the flat form the console has always sent
 * (`?status=failed&tag=etl`, repeatable for a set, `attr=key:op:value` repeats) dispatches through
 * bare-key hoisting, and the structured envelope (`filter[status]=failed`, `filter[tag][]=etl`,
 * `filter[attr]=tier:eq:pro`) dispatches to the SAME methods with `(value, operator, field)`.
 * Keeping the flat spelling working is not politeness to old callers — it is what lets a run
 * row's tag chip stay a plain link.
 *
 * Two deliberate divergences from a model filter, both load-bearing:
 * - `$query` is a {@link RunQueryDraft}, not SQL: there is nothing to append to, "building" is
 *   filling named predicates in, and everything the wire format can express but `RunQuery` cannot
 *   (`OR` groups, dotted `attr.<key>` fields) is refused at dispatch instead of accumulated.
 * - Unknown structured fields fail loudly (`InvalidColumnFilterError` → `400`) instead of
 *   silently widening the listing — which matters because the bulk actions act on the matched set.
 *   Bare legacy keys stay lenient (unknown ones are ignored, so pagination params keep working).
 */
export class RunFilter extends BaseFilter<RunQueryDraft> {
  declare $query: RunQueryDraft;

  /** One status narrows; several match ANY of them. Unknown values are ignored, not rejected. */
  status(value: unknown, operator: string): void {
    assertSetOperator('status', operator);
    const values = list(value)
      .map((v) => parseStatus(v))
      .filter((v): v is RunStatus => v !== undefined);
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { status: values[0] } : { statuses: values });
  }

  /** One workflow narrows; several match ANY of them. */
  workflow(value: unknown, operator: string): void {
    assertSetOperator('workflow', operator);
    const values = list(value);
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { workflow: values[0] } : { workflows: values });
  }

  /** One tag narrows to runs carrying it; several match runs carrying ANY of them. */
  tag(value: unknown, operator: string): void {
    assertSetOperator('tag', operator);
    const values = list(value);
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { tag: values[0] } : { tags: values });
  }

  /** One namespace narrows; several match ANY of them. A blank param is the same as an absent one. */
  namespace(value: unknown, operator: string): void {
    assertSetOperator('namespace', operator);
    const values = list(value);
    if (values.length === 0) return;
    this.$query.narrow(values.length === 1 ? { namespace: values[0] } : { namespaces: values });
  }

  /** Exact-match origin attribution — pushed down now that the engine has an `origin` column.
   *  The "unknown" bucket (absent origin) still filters client-side: an exact match can't express
   *  absence, exactly as the NestJS API behaves. */
  origin(value: unknown, operator: string): void {
    assertSetOperator('origin', operator);
    const values = list(value);
    if (values.length === 0) return;
    this.$query.narrow({ origin: values[0] });
  }

  /**
   * Search-attribute predicates, ANDed. Two spellings, one method:
   * - opaque repeats: `attr=key:op:value` (`attr=tier:in:pro|enterprise`), parsed as before;
   * - structured: `filter[attr.tier][equals]=pro`, with the full field naming the key (reached
   *   here through the head-segment fallback).
   */
  attr(value: unknown, operator: string, field: string): void {
    if (field !== 'attr') {
      const key = field.slice('attr.'.length);
      if (!key) {
        throw new InvalidColumnFilterError(
          'Filtering search attributes needs a key: `attr.<key>`.',
        );
      }
      const op = ATTR_OPERATORS[operator];
      if (!op) {
        throw new InvalidColumnFilterError(
          `Attribute "${key}" does not support the "${operator}" operator.`,
        );
      }
      if (op === 'in') {
        const values = asList(value)
          .filter((v) => v !== undefined && v !== null && v !== '')
          .map(coerceOperand);
        this.$query.attribute({ key, op: 'in', values });
        return;
      }
      if (value === undefined || value === null || value === '') return;
      this.$query.attribute({ key, op, value: coerceOperand(value) });
      return;
    }
    if (operator !== 'equals' && operator !== 'in' && operator !== 'isAnyOf') {
      throw new InvalidColumnFilterError(`"attr" does not support the "${operator}" operator.`);
    }
    for (const filter of parseAttrFilters(asStringList(value)) ?? []) {
      this.$query.attribute(filter);
    }
  }
}

/** Coerce a structured operand the way the legacy parser does, so numeric attributes compare as numbers. */
function coerceOperand(raw: unknown): string | number | boolean {
  return typeof raw === 'string' ? coerceAttrValue(raw) : (raw as string | number | boolean);
}

/** The legacy attr value shape: one opaque string or a list of them. */
function asStringList(value: unknown): string | string[] {
  return asList(value).filter((v): v is string => typeof v === 'string');
}

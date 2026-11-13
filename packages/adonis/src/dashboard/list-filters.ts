import { BaseFilter, InvalidColumnFilterError } from '@adonis-agora/filter';
import type { ScheduleInfo } from '../engine.js';
import { listValues } from './run-filter.js';

/** Operators a set-valued field accepts: one value narrows, several match ANY of them. */
function assertSetOperator(field: string, operator: string): void {
  if (operator !== 'equals' && operator !== 'in' && operator !== 'isAnyOf') {
    throw new InvalidColumnFilterError(`"${field}" does not support the "${operator}" operator.`);
  }
}

/** The predicates `GET /runs/:id/fans/:group` narrows its members by. */
export class FanMemberDraft {
  failedOnly = false;
}

/** `filter[status]=failed` keeps a fan's failed members only; no other status can be asked for. */
export class FanMemberFilter extends BaseFilter<FanMemberDraft> {
  declare $query: FanMemberDraft;

  status(value: unknown, operator: string): void {
    assertSetOperator('status', operator);
    const values = listValues(value);
    if (values.length === 0) return;
    if (values.length !== 1 || values[0] !== 'failed') {
      throw new InvalidColumnFilterError('Fan members filter by `status=failed` only.');
    }
    this.$query.failedOnly = true;
  }
}

/** The predicates `GET /schedules` narrows its rows by. */
export class ScheduleDraft {
  workflows?: string[];
  namespaces?: string[];
  paused?: boolean;

  /** Whether `schedule` matches every predicate set on the draft. */
  matches(schedule: ScheduleInfo): boolean {
    if (this.workflows && !this.workflows.includes(schedule.workflow)) return false;
    if (this.namespaces && !this.namespaces.includes(schedule.namespace ?? '')) return false;
    if (this.paused !== undefined && schedule.paused !== this.paused) return false;
    return true;
  }
}

/** `filter[workflow]`, `filter[namespace]` (one value or a set) and `filter[paused]=true|false`. */
export class ScheduleFilter extends BaseFilter<ScheduleDraft> {
  declare $query: ScheduleDraft;

  workflow(value: unknown, operator: string): void {
    assertSetOperator('workflow', operator);
    const values = listValues(value);
    if (values.length > 0) this.$query.workflows = values;
  }

  namespace(value: unknown, operator: string): void {
    assertSetOperator('namespace', operator);
    const values = listValues(value);
    if (values.length > 0) this.$query.namespaces = values;
  }

  paused(value: unknown, operator: string): void {
    if (operator !== 'equals') {
      throw new InvalidColumnFilterError(`"paused" does not support the "${operator}" operator.`);
    }
    const [raw] = listValues(value);
    if (raw === undefined) return;
    if (raw !== 'true' && raw !== 'false') {
      throw new InvalidColumnFilterError('"paused" takes `true` or `false`.');
    }
    this.$query.paused = raw === 'true';
  }
}

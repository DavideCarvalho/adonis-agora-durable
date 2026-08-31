import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { type CronParse, prevCronFireMs, resolveCronParse } from '../../src/scheduler.js';

// The optional `cron-parser` peer is declared as `^4.0.0 || ^5.0.0`, and the two majors have
// different APIs (v4 `parseExpression`, v5 `CronExpressionParser.parse`). The scheduler loads the
// module with a real `require`, so these tests feed `resolveCronParse` the REAL v4 and v5 modules
// (v4 via the `cron-parser-v4` npm alias devDependency) and assert both compute the same fires.
const nodeRequire = createRequire(import.meta.url);
const v5 = nodeRequire('cron-parser') as unknown;
const v4 = nodeRequire('cron-parser-v4') as unknown;

function prevFireWith(parse: CronParse, expr: string, nowMs: number, tz: string): number {
  return parse(expr, { currentDate: new Date(nowMs + 1), tz })
    .prev()
    .toDate()
    .getTime();
}

describe('cron-parser compatibility (v4 and v5 peer majors)', () => {
  it('the installed default is v5 and the aliased module is v4 (guards the test fixture itself)', () => {
    expect(typeof (v5 as { CronExpressionParser?: unknown }).CronExpressionParser).toBe('function');
    expect((v5 as { parseExpression?: unknown }).parseExpression).toBeUndefined();
    expect(typeof (v4 as { parseExpression?: unknown }).parseExpression).toBe('function');
    expect((v4 as { CronExpressionParser?: unknown }).CronExpressionParser).toBeUndefined();
  });

  it('resolves the v5 module shape (named `CronExpressionParser.parse`)', () => {
    const parse = resolveCronParse(v5);
    expect(parse).toBeTypeOf('function');
    const now = Date.UTC(2026, 0, 1, 5, 0, 0);
    expect(prevFireWith(parse!, '0 0 * * *', now, 'UTC')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it('resolves the v4 module shape (`parseExpression`)', () => {
    const parse = resolveCronParse(v4);
    expect(parse).toBeTypeOf('function');
    const now = Date.UTC(2026, 0, 1, 5, 0, 0);
    expect(prevFireWith(parse!, '0 0 * * *', now, 'UTC')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it('resolves ESM-interop wrappers (namespace under `default`) and the bare v5 class', () => {
    expect(resolveCronParse({ default: v4 })).toBeTypeOf('function');
    expect(resolveCronParse({ default: v5 })).toBeTypeOf('function');
    // v5's own `default` export is the `CronExpressionParser` class (a `parse` static).
    const klass = (v5 as { default: unknown }).default;
    expect(resolveCronParse(klass)).toBeTypeOf('function');
    expect(resolveCronParse({ default: klass })).toBeTypeOf('function');
  });

  it('rejects unrecognized shapes instead of guessing', () => {
    expect(resolveCronParse(undefined)).toBeUndefined();
    expect(resolveCronParse(null)).toBeUndefined();
    expect(resolveCronParse({})).toBeUndefined();
    expect(resolveCronParse({ default: {} })).toBeUndefined();
    expect(resolveCronParse('cron-parser')).toBeUndefined();
  });

  it('v4 and v5 agree on the previous fire across timezones, 6-field exprs and boundaries', () => {
    const p4 = resolveCronParse(v4)!;
    const p5 = resolveCronParse(v5)!;
    const cases: Array<[string, number, string]> = [
      ['0 0 * * *', Date.UTC(2026, 0, 1, 5, 0, 0), 'UTC'],
      // A fire landing exactly on `now` counts as "at or before now" (the +1 in the anchor).
      ['0 0 * * *', Date.UTC(2026, 0, 2, 0, 0, 0), 'UTC'],
      ['0 0 * * *', Date.UTC(2026, 2, 10, 4, 0, 0), 'America/Sao_Paulo'],
      ['*/15 * * * *', Date.UTC(2026, 5, 15, 12, 47, 13), 'UTC'],
      ['30 */6 * * 1-5', Date.UTC(2026, 5, 14, 3, 0, 0), 'Europe/Berlin'],
      ['*/10 * * * * *', Date.UTC(2026, 5, 15, 12, 47, 13, 500), 'UTC'],
    ];
    for (const [expr, now, tz] of cases) {
      const a = prevFireWith(p4, expr, now, tz);
      const b = prevFireWith(p5, expr, now, tz);
      expect(b, `${expr} @ ${new Date(now).toISOString()} ${tz}`).toBe(a);
      expect(b).toBeLessThanOrEqual(now);
    }
    expect(prevFireWith(p5, '0 0 * * *', Date.UTC(2026, 0, 2, 0, 0, 0), 'UTC')).toBe(
      Date.UTC(2026, 0, 2, 0, 0, 0),
    );
    expect(prevFireWith(p5, '0 0 * * *', Date.UTC(2026, 2, 10, 4, 0, 0), 'America/Sao_Paulo')).toBe(
      Date.UTC(2026, 2, 10, 3, 0, 0),
    );
  });

  it('prevCronFireMs (the scheduler entry point) works against the installed peer', () => {
    // Exercises `loadCronParser` → `nodeRequire('cron-parser')` → `resolveCronParse` end to end.
    expect(prevCronFireMs('0 0 * * *', Date.UTC(2026, 0, 1, 5, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 0, 0, 0),
    );
    expect(prevCronFireMs('0 0 * * *', Date.UTC(2026, 2, 10, 4, 0, 0), 'America/Sao_Paulo')).toBe(
      Date.UTC(2026, 2, 10, 3, 0, 0),
    );
    // Walking back from an exclusive cursor yields strictly earlier fires (the backfill path).
    const fire = prevCronFireMs('0 0 * * *', Date.UTC(2026, 0, 3, 12, 0, 0));
    expect(prevCronFireMs('0 0 * * *', fire - 1)).toBe(Date.UTC(2026, 0, 2, 0, 0, 0));
  });
});

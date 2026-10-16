import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { prevCronFireMs, resolveCronParse } from '../../src/scheduler.js';

// The optional `cron-parser` peer is declared as `^5.0.0`. The scheduler loads it with a real
// `require`, so these tests feed `resolveCronParse` the REAL module plus the interop wrappers a
// loader can hand it, and pin the fires it computes to absolute instants.
const nodeRequire = createRequire(import.meta.url);
const v5 = nodeRequire('cron-parser') as unknown;

function prevFire(expr: string, nowMs: number, tz: string): number {
  const parse = resolveCronParse(v5);
  if (parse === undefined) throw new Error('the installed cron-parser did not resolve');
  return parse(expr, { currentDate: new Date(nowMs + 1), tz })
    .prev()
    .toDate()
    .getTime();
}

describe('cron-parser peer', () => {
  it('the installed module is v5 (guards the test fixture itself)', () => {
    expect(typeof (v5 as { CronExpressionParser?: unknown }).CronExpressionParser).toBe('function');
  });

  it('resolves the module shape (named `CronExpressionParser.parse`)', () => {
    const parse = resolveCronParse(v5);
    expect(parse).toBeTypeOf('function');
    const now = Date.UTC(2026, 0, 1, 5, 0, 0);
    expect(prevFire('0 0 * * *', now, 'UTC')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it('resolves ESM-interop wrappers (namespace under `default`) and the bare class', () => {
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
    // The v4 entry point. Recognising it would resolve to a parser whose options this scheduler
    // no longer passes correctly, so an unsupported major has to fail loudly at load.
    expect(resolveCronParse({ parseExpression: () => undefined })).toBeUndefined();
  });

  it('computes the previous fire across timezones, 6-field exprs and boundaries', () => {
    const cases: Array<[string, number, string, number]> = [
      ['0 0 * * *', Date.UTC(2026, 0, 1, 5, 0, 0), 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0)],
      // A fire landing exactly on `now` counts as "at or before now" (the +1 in the anchor).
      ['0 0 * * *', Date.UTC(2026, 0, 2, 0, 0, 0), 'UTC', Date.UTC(2026, 0, 2, 0, 0, 0)],
      // Midnight in Sao Paulo is 03:00 UTC.
      [
        '0 0 * * *',
        Date.UTC(2026, 2, 10, 4, 0, 0),
        'America/Sao_Paulo',
        Date.UTC(2026, 2, 10, 3, 0, 0),
      ],
      ['*/15 * * * *', Date.UTC(2026, 5, 15, 12, 47, 13), 'UTC', Date.UTC(2026, 5, 15, 12, 45, 0)],
      // 2026-06-14 is a Sunday, so `1-5` walks back to Friday's 18:30 Berlin time.
      [
        '30 */6 * * 1-5',
        Date.UTC(2026, 5, 14, 3, 0, 0),
        'Europe/Berlin',
        Date.UTC(2026, 5, 12, 16, 30, 0),
      ],
      [
        '*/10 * * * * *',
        Date.UTC(2026, 5, 15, 12, 47, 13, 500),
        'UTC',
        Date.UTC(2026, 5, 15, 12, 47, 10),
      ],
    ];
    for (const [expr, now, tz, expected] of cases) {
      const fire = prevFire(expr, now, tz);
      expect(fire, `${expr} @ ${new Date(now).toISOString()} ${tz}`).toBe(expected);
      expect(fire).toBeLessThanOrEqual(now);
    }
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

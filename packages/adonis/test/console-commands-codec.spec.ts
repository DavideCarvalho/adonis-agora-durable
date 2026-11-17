import { describe, expect, it } from 'vitest';
import { decodeConsoleValue, encodeConsoleValue } from '../src/console-commands.js';

/** What a console command's args and answer look like after the trip through Redis. */
const trip = (value: unknown) =>
  decodeConsoleValue(JSON.parse(JSON.stringify(encodeConsoleValue(value))));

describe('console command codec', () => {
  it('carries dates and undefined', () => {
    const at = new Date('2026-11-17T12:00:00.000Z');
    expect(trip(at)).toEqual(at);
    expect(trip(undefined)).toBeUndefined();
    expect(trip({ run: { at, n: 1, gone: undefined } })).toEqual({ run: { at, n: 1 } });
  });

  it('keeps a mid-array undefined as undefined, not null', () => {
    const out = trip(['run-1', undefined, { force: true }]) as unknown[];
    expect(out).toHaveLength(3);
    expect(out[1]).toBeUndefined();
    expect(1 in out).toBe(true);
    expect(trip([null, undefined])).toEqual([null, undefined]);
  });

  it('decodes user data shaped like a sentinel to itself', () => {
    const lookalikes = {
      a: { $durableDate: '2026-11-17T12:00:00.000Z' },
      b: { $durableUndefined: true },
      c: { $$durableDate: 'x', $durable: 1, plain$durableDate: 2 },
      d: [{ $durableDate: 'y' }],
    };
    expect(trip(lookalikes)).toEqual(lookalikes);
    expect(trip({ $durableDate: 'z' })).toEqual({ $durableDate: 'z' });
  });

  it('follows JSON for the rest', () => {
    expect(trip({ n: Number.NaN, f: () => 1, nested: { toJSON: () => 'json' } })).toEqual({
      n: null,
      nested: 'json',
    });
    expect(trip(new Date(Number.NaN))).toBeNull();
  });
});

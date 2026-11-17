/**
 * The JSON form of a console command's arguments and answer (see {@link
 * import('./interfaces.js').ConsoleCommand}): dates and `undefined` survive the trip, so the
 * console's handlers get back what the owning app's engine returned.
 *
 * A `Date` travels as `{ $durableDate: iso }` and `undefined` as `{ $durableUndefined: true }`. A
 * key of the caller's own that could be mistaken for one (any key `$durable…`, `$$durable…`, …) gets
 * one more leading `$` on the way out and loses it on the way back, so user data shaped like a
 * sentinel decodes to itself. `undefined` survives at the top level and inside arrays; an object
 * property set to `undefined` is dropped, as `JSON.stringify` drops it. Everything else follows
 * JSON: `toJSON()` is honored, functions and symbols vanish, `NaN` becomes `null`, and a `bigint`
 * throws.
 */

const DATE = '$durableDate';
const UNDEFINED = '$durableUndefined';
/** User keys that would read as a sentinel: escaped by one more leading `$`. */
const RESERVED_KEY = /^\$+durable/;

/** `value` as plain JSON data, dates and `undefined` tagged. */
export function encodeConsoleValue(value: unknown): unknown {
  const text = JSON.stringify(tag(value));
  return text === undefined ? { [UNDEFINED]: true } : JSON.parse(text);
}

function tag(value: unknown): unknown {
  if (value === undefined) return { [UNDEFINED]: true };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { [DATE]: value.toISOString() };
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(tag);
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') return tag(toJSON.call(value));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue;
    out[RESERVED_KEY.test(key) ? `$${key}` : key] = tag(inner);
  }
  return out;
}

/** The value {@link encodeConsoleValue} encoded. */
export function decodeConsoleValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeConsoleValue);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && record[UNDEFINED] === true) return undefined;
  if (keys.length === 1 && typeof record[DATE] === 'string') {
    return new Date(record[DATE] as string);
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    const decoded = decodeConsoleValue(inner);
    if (decoded !== undefined) out[RESERVED_KEY.test(key) ? key.slice(1) : key] = decoded;
  }
  return out;
}

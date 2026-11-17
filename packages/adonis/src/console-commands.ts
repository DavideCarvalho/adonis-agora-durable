/**
 * The JSON form of a console command's arguments and answer (see {@link
 * import('./interfaces.js').ConsoleCommand}): dates and `undefined` survive the trip, so the
 * console's handlers get back what the owning app's engine returned.
 */

const DATE = '$durableDate';
const UNDEFINED = '$durableUndefined';

/** `value` as plain JSON data, dates and `undefined` tagged. */
export function encodeConsoleValue(value: unknown): unknown {
  if (value === undefined) return { [UNDEFINED]: true };
  const text = JSON.stringify(value, function (this: Record<string, unknown>, key, current) {
    const raw = this[key];
    if (raw instanceof Date) return { [DATE]: raw.toISOString() };
    return current;
  });
  return text === undefined ? { [UNDEFINED]: true } : JSON.parse(text);
}

/** The value {@link encodeConsoleValue} encoded. */
export function decodeConsoleValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeConsoleValue);
  const record = value as Record<string, unknown>;
  if (record[UNDEFINED] === true && Object.keys(record).length === 1) return undefined;
  if (typeof record[DATE] === 'string' && Object.keys(record).length === 1) {
    return new Date(record[DATE] as string);
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    const decoded = decodeConsoleValue(inner);
    if (decoded !== undefined) out[key] = decoded;
  }
  return out;
}

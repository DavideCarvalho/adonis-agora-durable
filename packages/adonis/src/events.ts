// Named events: pub/sub on top of the signal-waiter table. A `ctx.waitForEvent(name, { match })`
// registers a signal waiter whose token encodes the event name + match criteria (base64 so they
// never contain the `:` delimiter); `engine.publishEvent(name, payload)` lists the waiters for that
// name by token prefix, checks each one's match against the payload, and signals the ones that pass.
// No schema change beyond a `listSignalWaiters(prefix)` store method.

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const dec = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

/**
 * How many candidates a buffered-event scan considers (`listBufferedEvents(name, limit)`) before
 * giving up. An event's buffer is keyed by `name` only (see {@link eventMatches}'s match-based
 * consumption), so a hot name with many distinct payloads sitting unclaimed could in principle
 * accumulate an unbounded backlog; this caps the per-scan cost regardless. Shared by the workflow-ctx
 * consumer and the engine's reconcile paths so both see the same window.
 */
export const EVENT_BUFFER_SCAN_LIMIT = 50;

/** The literal prefix EVERY event-waiter token starts with, regardless of `name` — `eventPrefix(name)`
 *  always begins with this; exported so a caller that only needs to CLASSIFY a token (not fan out a
 *  specific name) doesn't have to re-derive or duplicate the literal. */
export const EVENT_TOKEN_PREFIX = 'event:';

/** Token prefix for every waiter on `name` — used by `listSignalWaiters` to fan an event out. */
export function eventPrefix(name: string): string {
  return `${EVENT_TOKEN_PREFIX}${enc(name)}:`;
}

/** Whether `token` is an event-waiter token (vs. a plain signal / child / webhook / breakpoint one). */
export function isEventToken(token: string): boolean {
  return token.startsWith(EVENT_TOKEN_PREFIX);
}

/** The event NAME embedded in an event-waiter token (the 2nd `:`-segment is the base64 name). */
export function eventNameOf(token: string): string {
  try {
    return dec(token.split(':')[1] ?? '');
  } catch {
    return token;
  }
}

/** Build the unique waiter token for one `waitForEvent` call (name + match + run position). */
export function eventToken(
  name: string,
  match: Record<string, unknown> | undefined,
  runId: string,
  seq: number,
): string {
  return `${eventPrefix(name)}${enc(JSON.stringify(match ?? {}))}:${runId}#${seq}`;
}

/** The match criteria embedded in an event waiter token (the 3rd `:`-segment is the base64 match). */
export function eventMatchOf(token: string): Record<string, unknown> {
  try {
    return JSON.parse(dec(token.split(':')[2] ?? '')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Whether `payload` satisfies a waiter's `match`: every match key deep-equals the payload's value. */
export function eventMatches(payload: unknown, match: Record<string, unknown>): boolean {
  const keys = Object.keys(match);
  if (keys.length === 0) return true; // no criteria → matches any payload of this name
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return keys.every((k) => JSON.stringify(p[k]) === JSON.stringify(match[k]));
}

/**
 * One `onEvent` subscription: the event name, plus an optional `where` that decides, per payload,
 * whether this workflow starts, and an optional `input` that turns the payload into the started
 * run's input. A bare string is shorthand for `{ event }`. Both functions run in the publishing
 * process, so they only exist for subscriptions registered in TypeScript.
 */
export interface EventSubscription {
  event: string;
  where?: ((payload: unknown) => boolean) | undefined;
  /** The started run's input, built from the payload. Defaults to the payload itself. */
  input?: ((payload: unknown) => unknown) | undefined;
}

/** An `onEvent` entry: an event name, or a {@link EventSubscription}. */
export type OnEventEntry = string | EventSubscription;

/** Normalize an `onEvent` entry to its {@link EventSubscription} form. */
export function toEventSubscription(entry: OnEventEntry): EventSubscription {
  return typeof entry === 'string' ? { event: entry } : entry;
}

/**
 * Which of one workflow's subscriptions to an event takes `payload`: the first whose `where`
 * accepts it (a subscription without `where` accepts everything). A `where` that throws counts as
 * a rejection, and its error is returned so the caller can report it instead of losing it.
 */
export function acceptingSubscription(
  subscriptions: readonly EventSubscription[],
  payload: unknown,
): { accepted?: EventSubscription; errors: unknown[] } {
  const errors: unknown[] = [];
  for (const subscription of subscriptions) {
    if (!subscription.where) return { accepted: subscription, errors };
    try {
      if (subscription.where(payload)) return { accepted: subscription, errors };
    } catch (error) {
      errors.push(error);
    }
  }
  return { errors };
}

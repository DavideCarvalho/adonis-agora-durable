import { SignalTimeoutError } from './errors.js';
import type { WorkflowCtx } from './interfaces.js';
import { PACKAGE_ORIGIN } from './package-origin.js';

/**
 * How `onEvent` triggers are coalesced into fewer runs (see the `onEvent` `debounce`/`batch` config).
 * `key`, computed from the subscriber's input (after its subscription's `input` mapping), gives each
 * distinct key its own accumulator, so events coalesce per key instead of per workflow.
 */
export type EventBatchConfig =
  | { mode: 'debounce'; windowMs: number; key?: ((input: unknown) => string) | undefined }
  | {
      mode: 'batch';
      maxSize: number;
      windowMs: number;
      key?: ((input: unknown) => string) | undefined;
    };

/** The slice of the engine the accumulators need (so they stay a standalone module). */
export interface AccumulatorHost {
  register(
    name: string,
    version: string,
    fn: (ctx: WorkflowCtx, input: unknown) => Promise<unknown>,
    opts?: { origin?: string | undefined },
  ): void;
  signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
  ): Promise<{ runId: string }>;
}

/**
 * The accumulator run id, which is also its signal token: `__evtacc__:<target>` without a key, and
 * `__evtacc__:<target>#<key>` with one, the key percent-encoded (`~` too, which marks a
 * continue-as-new run id) so any key string makes a safe id.
 */
export function accumulatorRunId(target: string, key?: string): string {
  const base = `__evtacc__:${target}`;
  return key === undefined ? base : `${base}#${encodeURIComponent(key).replace(/~/g, '%7E')}`;
}

/**
 * Built-in workflows that coalesce `onEvent` triggers. Each is a long-lived per-target accumulator
 * fed by `signalWithStart`: it collects payloads then starts the target once, and `continueAsNew`s to
 * re-arm for the next burst. Signal buffering keeps the re-arm race-free. Registers its runners on
 * construction.
 */
export class EventAccumulators {
  constructor(private readonly host: AccumulatorHost) {
    const opts = { origin: PACKAGE_ORIGIN };
    host.register('__evt_debounce', '1', (ctx, input) => this.debounce(ctx, input), opts);
    host.register('__evt_batch', '1', (ctx, input) => this.batch(ctx, input), opts);
  }

  /**
   * Route an `onEvent` payload into its target's debounce/batch accumulator (the one for its key).
   * `dedupeId` names the event for this target (a lifecycle event: its source run and subscriber), so
   * the accumulator drops a second route of the same event instead of counting it twice.
   */
  route(
    target: string,
    config: EventBatchConfig,
    payload: unknown,
    dedupeId?: string,
  ): Promise<{ runId: string }> {
    const key = config.key ? config.key(payload) : undefined;
    if (key !== undefined && typeof key !== 'string') {
      throw new TypeError(`eventBatch key for ${target} returned ${typeof key}, expected a string`);
    }
    const keyed = key !== undefined ? { key } : {};
    const [workflow, input] =
      config.mode === 'debounce'
        ? (['__evt_debounce', { target, windowMs: config.windowMs, ...keyed }] as const)
        : ([
            '__evt_batch',
            { target, maxSize: config.maxSize, windowMs: config.windowMs, ...keyed },
          ] as const);
    const id = accumulatorRunId(target, key);
    const signal = dedupeId !== undefined ? { [ROUTED_EVENT]: dedupeId, payload } : payload;
    return this.host.signalWithStart(workflow, input, id, { token: id, payload: signal });
  }

  /**
   * Fire the target with the LAST payload once events have been quiet for `windowMs`. An event it
   * already took (same dedupe id, in this burst or the {@link SEEN_CAP} before) is dropped: it never
   * becomes the payload, nor starts a burst.
   */
  private async debounce(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, windowMs, key, seen } = input as {
      target: string;
      windowMs: number;
      key?: string;
      seen?: string[];
    };
    const token = accumulatorRunId(target, key);
    const ids = new Seen(seen);
    let last: unknown;
    for (;;) {
      const event = unwrap(await ctx.waitForSignal(token)); // park for the first event of a burst
      if (!ids.take(event.id)) continue;
      last = event.payload;
      break;
    }
    for (;;) {
      try {
        // extend on each event
        const event = unwrap(await ctx.waitForSignal(token, { timeoutMs: windowMs }));
        if (ids.take(event.id)) last = event.payload;
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // quiet for `windowMs` → fire
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, last);
    return ctx.continueAsNew(ids.carry(input)); // re-arm
  }

  /**
   * Fire the target with all payloads (`{ events }`) once `maxSize` or `windowMs` from the first. An
   * event it already took (same dedupe id, in this burst or the {@link SEEN_CAP} before) is dropped.
   */
  private async batch(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, maxSize, windowMs, key, seen } = input as {
      target: string;
      maxSize: number;
      windowMs: number;
      key?: string;
      seen?: string[];
    };
    const token = accumulatorRunId(target, key);
    const ids = new Seen(seen);
    const events: unknown[] = [];
    // Park for the first.
    while (events.length === 0) {
      const event = unwrap(await ctx.waitForSignal(token));
      if (ids.take(event.id)) events.push(event.payload);
    }
    const deadline = (await ctx.now()) + windowMs;
    while (events.length < maxSize) {
      const remaining = deadline - (await ctx.now());
      if (remaining <= 0) break;
      try {
        const event = unwrap(await ctx.waitForSignal(token, { timeoutMs: remaining }));
        if (ids.take(event.id)) events.push(event.payload);
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // window elapsed → fire what we have
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, { events });
    return ctx.continueAsNew(ids.carry(input)); // re-arm
  }
}

/** The key of a routed event's dedupe id in the signal payload (see {@link EventAccumulators.route}). */
const ROUTED_EVENT = '__durableRoutedEvent';

/** How many dedupe ids an accumulator carries into its next burst. */
const SEEN_CAP = 200;

/** A signal payload as routed: its dedupe id when it has one, and the subscriber's input. */
function unwrap(signal: unknown): { id?: string; payload: unknown } {
  if (signal && typeof signal === 'object' && ROUTED_EVENT in signal) {
    const routed = signal as { [ROUTED_EVENT]: unknown; payload?: unknown };
    const id = routed[ROUTED_EVENT];
    if (typeof id === 'string') return { id, payload: routed.payload };
  }
  return { payload: signal };
}

/** The dedupe ids an accumulator has taken: this burst's, and the last ones of earlier bursts. */
class Seen {
  private readonly ids: string[];
  private readonly set: Set<string>;
  constructor(carried: readonly string[] | undefined) {
    this.ids = [...(carried ?? [])];
    this.set = new Set(this.ids);
  }

  /** Record `id`; false when it was already taken. An event without an id is always new. */
  take(id: string | undefined): boolean {
    if (id === undefined) return true;
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.ids.push(id);
    return true;
  }

  /** `input` for the next burst, carrying the last {@link SEEN_CAP} ids. */
  carry(input: unknown): unknown {
    const { seen: _seen, ...rest } = input as { seen?: unknown };
    return this.ids.length > 0 ? { ...rest, seen: this.ids.slice(-SEEN_CAP) } : rest;
  }
}

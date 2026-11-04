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

  /** Route an `onEvent` payload into its target's debounce/batch accumulator (the one for its key). */
  route(target: string, config: EventBatchConfig, payload: unknown): Promise<{ runId: string }> {
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
    return this.host.signalWithStart(workflow, input, id, { token: id, payload });
  }

  /** Fire the target with the LAST payload once events have been quiet for `windowMs`. */
  private async debounce(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, windowMs, key } = input as { target: string; windowMs: number; key?: string };
    const token = accumulatorRunId(target, key);
    let last = await ctx.waitForSignal(token); // park for the first event of a burst
    for (;;) {
      try {
        last = await ctx.waitForSignal(token, { timeoutMs: windowMs }); // extend on each event
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // quiet for `windowMs` → fire
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, last);
    return ctx.continueAsNew(input); // re-arm
  }

  /** Fire the target with all payloads (`{ events }`) once `maxSize` or `windowMs` from the first. */
  private async batch(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, maxSize, windowMs, key } = input as {
      target: string;
      maxSize: number;
      windowMs: number;
      key?: string;
    };
    const token = accumulatorRunId(target, key);
    const events: unknown[] = [await ctx.waitForSignal(token)]; // park for the first
    const deadline = (await ctx.now()) + windowMs;
    while (events.length < maxSize) {
      const remaining = deadline - (await ctx.now());
      if (remaining <= 0) break;
      try {
        events.push(await ctx.waitForSignal(token, { timeoutMs: remaining }));
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // window elapsed → fire what we have
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, { events });
    return ctx.continueAsNew(input); // re-arm
  }
}

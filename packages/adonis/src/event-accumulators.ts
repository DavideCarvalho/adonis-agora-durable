import { SignalTimeoutError } from './errors.js';
import type { WorkflowCtx } from './interfaces.js';
import { PACKAGE_ORIGIN } from './package-origin.js';

/** How `onEvent` triggers are coalesced into fewer runs (see the `onEvent` `debounce`/`batch` config). */
export type EventBatchConfig =
  | { mode: 'debounce'; windowMs: number }
  | { mode: 'batch'; maxSize: number; windowMs: number };

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

const accToken = (target: string): string => `__evtacc__:${target}`;

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

  /** Route an `onEvent` payload into its target's debounce/batch accumulator. */
  route(target: string, config: EventBatchConfig, payload: unknown): Promise<{ runId: string }> {
    const [workflow, input] =
      config.mode === 'debounce'
        ? (['__evt_debounce', { target, windowMs: config.windowMs }] as const)
        : ([
            '__evt_batch',
            { target, maxSize: config.maxSize, windowMs: config.windowMs },
          ] as const);
    return this.host.signalWithStart(workflow, input, accToken(target), {
      token: accToken(target),
      payload,
    });
  }

  /** Fire the target with the LAST payload once events have been quiet for `windowMs`. */
  private async debounce(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, windowMs } = input as { target: string; windowMs: number };
    const token = accToken(target);
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
    const { target, maxSize, windowMs } = input as {
      target: string;
      maxSize: number;
      windowMs: number;
    };
    const token = accToken(target);
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

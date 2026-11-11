import type { WorkflowEngine } from './engine.js';
import type { NormalizedEventTrigger } from './workflow-events.js';

/** The minimal Adonis emitter surface the bridge needs (its `on`/`off` take a handler). */
export interface EmitterLike {
  on(event: string, handler: (payload: unknown) => void): unknown;
  off(event: string, handler: (payload: unknown) => void): unknown;
}

export interface EventTriggerBridgeOptions {
  /** The engine the bridge starts/publishes on. */
  engine: WorkflowEngine;
  /** The AdonisJS app emitter, when resolvable (missing = emitter triggers are inert). */
  emitter?: EmitterLike;
  /**
   * Called when a triggered start or publish fails (an unregistered workflow, a rejected input, a
   * concurrency quota, a store error). Default: a `console.warn`. The bridge always catches, so a
   * failing trigger never becomes an unhandled rejection that could take the process down.
   */
  onError?: (error: unknown, info: { trigger: NormalizedEventTrigger }) => void;
}

/** Run a trigger's start/publish, routing a rejection to `onError` (or a warning). */
function fire(
  trigger: NormalizedEventTrigger,
  options: EventTriggerBridgeOptions,
  run: () => Promise<unknown>,
): void {
  const report = (error: unknown): void => {
    try {
      if (options.onError) {
        options.onError(error, { trigger });
        return;
      }
    } catch {
      /* a throwing reporter must not escape either; fall through to the warning */
    }
    console.warn(
      `[durable] event trigger for workflow "${trigger.workflow}" (${String(trigger.event)}) failed:`,
      error,
    );
  };
  try {
    run().catch(report);
  } catch (error) {
    report(error);
  }
}

/** One subscription installed by the bridge (for exact teardown). */
interface Wire {
  disposer(): void;
}

/**
 * Bridge the AdonisJS emitter events a workflow declares via `static on` / `@OnEvent` into the
 * engine: each event becomes `engine.publishEvent(name, payload)` — a fresh run of every workflow
 * registered with `onEvent: [name]`, with the payload as input (idempotent by
 * `evt:<id>:<workflow>`). Without an emitter the triggers are inert.
 *
 * @returns a disposer that detaches every subscription.
 */
export function attachEventTriggerBridge(
  triggers: readonly NormalizedEventTrigger[],
  options: EventTriggerBridgeOptions,
): () => void {
  const wires: Wire[] = [];
  for (const trigger of triggers) {
    // Only emitter triggers exist; a hand-built trigger with another source (the removed
    // `source: 'diagnostics'`) must fail, not silently subscribe an emitter event of that name.
    if ((trigger as { source?: unknown }).source !== 'emitter') {
      throw new Error(
        `durable: event trigger of workflow "${trigger.workflow}" has source "${String((trigger as { source?: unknown }).source)}"; only 'emitter' (\`@OnEvent\`) is supported.`,
      );
    }
  }
  for (const trigger of triggers) wires.push(wireEmitter(trigger, options));
  return () => {
    while (wires.length) wires.pop()?.disposer();
  };
}

function wireEmitter(trigger: NormalizedEventTrigger, options: EventTriggerBridgeOptions): Wire {
  if (!options.emitter) return { disposer: () => {} };
  const handler = (payload: unknown) => {
    fire(trigger, options, () => options.engine.publishEvent(trigger.event, payload));
  };
  options.emitter.on(trigger.event, handler);
  return { disposer: () => options.emitter?.off(trigger.event, handler) };
}

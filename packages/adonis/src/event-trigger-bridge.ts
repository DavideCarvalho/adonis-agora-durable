import diagnostics_channel from 'node:diagnostics_channel';
import type { WorkflowEngine } from './engine.js';
import { eventTriggerCanonicalName, type NormalizedEventTrigger } from './workflow-events.js';

/** The `@adonis-agora/diagnostics` channel registry, read STRUCTURALLY (durable never imports it). */
const DIAGNOSTICS_REGISTRY_KEY = Symbol.for('@agora/diagnostics:registry');
interface DiagnosticsRegistryLike {
  channels: Set<string>;
  listeners: Set<(name: string) => void>;
}
function diagnosticsRegistry(): DiagnosticsRegistryLike | undefined {
  return (globalThis as Record<symbol, unknown>)[DIAGNOSTICS_REGISTRY_KEY] as
    | DiagnosticsRegistryLike
    | undefined;
}

/** The diagnostics channel envelope published on `agora:<lib>:<event>` (structural mirror). */
interface DiagnosticsEnvelope {
  event?: string;
  payload?: unknown;
}

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
}

/** One subscription installed by the bridge (for exact teardown). */
interface Wire {
  disposer(): void;
}

/**
 * Bridge the event sources a workflow declares via `static on` / `@OnEvent` / `@OnDiagnostic`
 * into the engine:
 *
 * - **Adonis emitter** (exact names) → `engine.publishEvent(name, payload)` — a fresh run
 *   of every workflow registered with `onEvent: [name]`, with the payload as input
 *   (idempotent by `evt:<id>:<workflow>`).
 * - **Diagnostics** (`agora:<lib>:<event>` channels): exact triggers route through
 *   `publishEvent(canonical, payload)`; regex/any triggers start the workflow directly
 *   (the concrete name is unknown at registration time).
 *
 * Diagnostics channels are subscribed via `node:diagnostics_channel` + the registry slot
 * (current + future channels), so durable needs no import of `@adonis-agora/diagnostics`.
 * Missing source (no emitter) degrades gracefully — that trigger just never fires.
 *
 * @returns a disposer that detaches every subscription.
 */
export function attachEventTriggerBridge(
  triggers: readonly NormalizedEventTrigger[],
  options: EventTriggerBridgeOptions,
): () => void {
  const wires: Wire[] = [];
  for (const trigger of triggers) {
    if (trigger.source === 'emitter') wires.push(wireEmitter(trigger, options));
    else wires.push(wireDiagnostics(trigger, options));
  }
  return () => {
    while (wires.length) wires.pop()?.disposer();
  };
}

function wireEmitter(
  trigger: Extract<NormalizedEventTrigger, { source: 'emitter' }>,
  options: EventTriggerBridgeOptions,
): Wire {
  if (!options.emitter) return { disposer: () => {} };
  const handler = (payload: unknown) => {
    void options.engine.publishEvent(trigger.event, payload);
  };
  options.emitter.on(trigger.event, handler);
  return { disposer: () => options.emitter?.off(trigger.event, handler) };
}

function wireDiagnostics(
  trigger: Extract<NormalizedEventTrigger, { source: 'diagnostics' }>,
  options: EventTriggerBridgeOptions,
): Wire {
  const exact = typeof trigger.event === 'string';
  const re = trigger.event instanceof RegExp ? trigger.event : null;
  const libPrefix = `agora:${trigger.lib}:`;
  const subscriptions = new Map<string, (msg: unknown) => void>();

  const onMessage = (message: unknown) => {
    const envelope = message as DiagnosticsEnvelope;
    if (envelope === null || typeof envelope !== 'object') return;
    const payload = envelope.payload;
    if (exact) {
      const name = eventTriggerCanonicalName(trigger);
      if (name !== null) void options.engine.publishEvent(name, payload);
    } else {
      // Regex/any: the concrete name is unknown upfront — start the workflow directly.
      void options.engine.start(trigger.workflow, payload, crypto.randomUUID());
    }
  };

  const subscribeChannel = (name: string) => {
    if (subscriptions.has(name)) return;
    if (!name.startsWith(libPrefix)) return;
    if (exact) {
      if (name !== `${libPrefix}${trigger.event}`) return;
    } else if (re) {
      const eventPart = name.slice(libPrefix.length);
      if (!eventPart.match(re)) return;
    }
    const handler = (msg: unknown) => onMessage(msg);
    subscriptions.set(name, handler);
    diagnostics_channel.channel(name).subscribe(handler);
  };

  // EXACT triggers know their channel (`agora:<lib>:<event>`) — subscribe directly, no
  // registry needed. Regex/any triggers need the diagnostics registry to discover the
  // current `agora:<lib>:*` channels (and to learn about future ones as they appear).
  if (exact) {
    subscribeChannel(`${libPrefix}${trigger.event}`);
  } else {
    const registry = diagnosticsRegistry();
    let registryListener: ((name: string) => void) | null = null;
    if (registry) {
      for (const name of registry.channels) subscribeChannel(name);
      registryListener = (name: string) => subscribeChannel(name);
      registry.listeners.add(registryListener);
    }
    // Registry may be absent (diagnostics not loaded): subscribe to the lib's known
    // channels is impossible without it — those triggers stay inert until it is.
    return {
      disposer: () => {
        if (registryListener && registry) registry.listeners.delete(registryListener);
        for (const [name, handler] of subscriptions) {
          diagnostics_channel.channel(name).unsubscribe(handler);
        }
        subscriptions.clear();
      },
    };
  }

  return {
    disposer: () => {
      for (const [name, handler] of subscriptions) {
        diagnostics_channel.channel(name).unsubscribe(handler);
      }
      subscriptions.clear();
    },
  };
}

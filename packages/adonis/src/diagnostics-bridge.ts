import { parentRunIdOf } from './fan-join.js';
import type { EngineEvent } from './interfaces.js';
import { isRemoteEvent } from './remote-event.js';

/** The minimal engine surface the bridge needs: a lifecycle-event subscription. */
export interface DurableEventSource {
  subscribe(listener: (event: EngineEvent) => void): () => void;
}

/** The `@adonis-agora/diagnostics` emit capability, published on this slot at that package's module load. */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/** Options for {@link attachDurableDiagnostics}. */
export interface DurableDiagnosticsOptions {
  /**
   * Also forward the events this instance only HEARD from other instances over the control plane.
   * Default `false`: with a control plane configured, every pod receives every other pod's lifecycle
   * events, so forwarding them made each pod's Telescope record each event once per pod (a
   * three-pod fleet counted every `run.completed` three times). Set it on a pod that should mirror
   * the whole fleet into a recorder of its own, and nowhere else.
   */
  includeRemote?: boolean | undefined;
}

/**
 * Bridge engine lifecycle events onto the `@adonis-agora/diagnostics` bus as `agora:durable:<type>`
 * (e.g. `agora:durable:run.failed`); the whole {@link EngineEvent} is the payload. The emit
 * capability is read STRUCTURALLY from its global slot per event — durable never imports or depends
 * on `@adonis-agora/diagnostics`, and when diagnostics isn't installed the slot is empty and this is an
 * inert subscription.
 *
 * One bridge lights up everything downstream of the diagnostics hub at once: `onDiagnostic('durable')`
 * subscribers, the Telescope generic watcher (which auto-captures every channel), the cross-process
 * relays, and the OTel bridge (each event recorded on the active span). `emit` short-circuits on
 * `hasSubscribers`, so an unsubscribed channel costs nothing, and it never throws back into the
 * engine. Only the events THIS instance produced are forwarded by default (see
 * {@link DurableDiagnosticsOptions.includeRemote}), so a fleet records each event once; all event
 * types are forwarded — filtering is the subscriber's job. An event of a child run
 * the engine started (`ctx.all`, `ctx.child`, `ctx.startChild` without a caller-chosen id) also
 * carries `parentRunId`: each child is its own run, so that field is how a subscriber (a Telescope
 * search, say) finds every child of one parent, a whole `ctx.all` fan included.
 *
 * @returns an unsubscribe function that detaches the bridge from the engine.
 */
export function attachDurableDiagnostics(
  engine: DurableEventSource,
  options: DurableDiagnosticsOptions = {},
): () => void {
  const includeRemote = options.includeRemote === true;
  return engine.subscribe((event: EngineEvent) => {
    if (!includeRemote && isRemoteEvent(event)) return;
    const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
    if (typeof emit !== 'function') return;
    const parentRunId = parentRunIdOf(event.runId);
    emit('durable', event.type, parentRunId ? { ...event, parentRunId } : event);
  });
}

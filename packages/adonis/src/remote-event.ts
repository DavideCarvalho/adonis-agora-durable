import type { EngineEvent } from './interfaces.js';

/**
 * The lifecycle events an engine re-delivered from ANOTHER instance's control-plane broadcast,
 * remembered by identity. Every instance hears every other instance's events (that is what makes a
 * cross-pod live-tail work), so a consumer that RECORDS events (the diagnostics bridge feeding
 * Telescope, a metrics counter) would count each one once per pod. `isRemoteEvent` lets such a
 * consumer keep only the events its own instance produced. A WeakSet: no field on the event, nothing
 * on the wire, and no retention once the event is dropped.
 */
const remoteEvents = new WeakSet<object>();

/** Mark `event` as received from another instance (the engine does this on control-plane receipt). */
export function markRemoteEvent<E extends EngineEvent>(event: E): E {
  remoteEvents.add(event);
  return event;
}

/** Whether `event` was produced by another instance and re-delivered here over the control plane. */
export function isRemoteEvent(event: EngineEvent): boolean {
  return remoteEvents.has(event);
}

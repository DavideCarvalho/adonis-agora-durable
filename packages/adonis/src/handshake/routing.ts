/**
 * Capability-aware routing (design §7.5). A workflow/step handler may declare
 * `requires: ['saga', 'search-attr-v2']`; the control-plane dispatches only to workers whose
 * descriptor advertises every required capability. If no live capable worker exists the run must
 * **park as `blocked`** with a precise reason (visible in the dashboard) — never a silent hang.
 *
 * Pure logic: no transport, no store. Consumers (the dispatcher/provider) feed live descriptors in.
 */

import {
  normalizeDescriptor,
  type RawWorkerDescriptor,
  type WorkerDescriptor,
} from './descriptor.js';

/** A handler's capability demand — either a bare list, or anything carrying a `requires` array
 *  (a workflow/step ref). An absent/empty list means "runs anywhere" (design §7.5). */
export type CapabilityRequirement = string[] | { requires?: string[] };

/** Normalize the two accepted shapes to a de-duplicated list of required capability names. */
export function requiredCapabilities(handler: CapabilityRequirement): string[] {
  const list = Array.isArray(handler) ? handler : (handler.requires ?? []);
  return [...new Set(list)];
}

/**
 * Can `worker` run a handler with these requirements? True iff the worker's (normalized) descriptor
 * advertises **every** required capability. A legacy worker (no `capabilities` field) is normalized
 * to the v1 baseline first (design §7.7), so it can still run baseline-only work.
 */
export function canRoute(
  handler: CapabilityRequirement,
  worker: RawWorkerDescriptor | WorkerDescriptor,
): boolean {
  const required = requiredCapabilities(handler);
  if (required.length === 0) return true;
  const advertised = new Set(normalizeDescriptor(worker).capabilities);
  return required.every((cap) => advertised.has(cap));
}

/**
 * The capabilities a handler requires that `worker` does NOT advertise — the precise routing delta.
 * Empty iff {@link canRoute} is true.
 */
export function missingCapabilities(
  handler: CapabilityRequirement,
  worker: RawWorkerDescriptor | WorkerDescriptor,
): string[] {
  const advertised = new Set(normalizeDescriptor(worker).capabilities);
  return requiredCapabilities(handler).filter((cap) => !advertised.has(cap));
}

/** Filter a fleet down to the workers that can run a handler (design §7.5). */
export function capableWorkers<T extends RawWorkerDescriptor | WorkerDescriptor>(
  handler: CapabilityRequirement,
  workers: readonly T[],
): T[] {
  return workers.filter((w) => canRoute(handler, w));
}

/** A run is dispatchable — at least one live worker can execute the handler. */
export interface RoutableResolution {
  status: 'routable';
  /** The normalized subset of the fleet that can run it. */
  workers: WorkerDescriptor[];
  requires: string[];
}

/** No live capable worker — the run parks as `blocked` with a human reason (design §7.5). */
export interface BlockedResolution {
  status: 'blocked';
  /** Exactly the dashboard copy: `blocked: no compatible worker (requires <caps>)`. */
  reason: string;
  requires: string[];
}

export type RoutingResolution = RoutableResolution | BlockedResolution;

/**
 * Decide whether a handler can be dispatched to the given live fleet (design §7.5). Returns
 * `routable` with the capable subset, or `blocked` with a precise reason when nobody can run it —
 * so the run parks visibly instead of hanging silently. An empty fleet always blocks.
 */
export function resolveRouting(
  handler: CapabilityRequirement,
  workers: readonly (RawWorkerDescriptor | WorkerDescriptor)[],
): RoutingResolution {
  const requires = requiredCapabilities(handler);
  const capable = capableWorkers(handler, workers).map(normalizeDescriptor);

  if (capable.length > 0) {
    return { status: 'routable', workers: capable, requires };
  }

  const suffix = requires.length > 0 ? ` (requires ${requires.join(', ')})` : '';
  return {
    status: 'blocked',
    reason: `blocked: no compatible worker${suffix}`,
    requires,
  };
}

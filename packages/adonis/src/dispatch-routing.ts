/**
 * Capability- & protocol-aware dispatch planning (design §7.5/§7.6). Sits BETWEEN the pure handshake
 * (`resolveRouting`/`negotiate`, `src/handshake/*`) and the engine's dispatch path: given a step's/
 * workflow's required capabilities and the LIVE worker descriptors for its routing token, decide
 * whether a live worker can actually run it — and if not, produce the LOUD, structured reason the
 * engine parks the run `blocked` with (never a silent hang into a queue nobody consumes).
 *
 * Pure logic + a small control-plane descriptor factory: no transport, no store, no I/O. The engine
 * feeds in descriptors it read off the broker and acts on the returned plan.
 */

import {
  CURRENT_PROTOCOL_VERSION,
  type RawWorkerDescriptor,
  type WorkerDescriptor,
  normalizeDescriptor,
} from './handshake/descriptor.js';
import { negotiate } from './handshake/negotiate.js';
import { canRoute, requiredCapabilities } from './handshake/routing.js';

/**
 * Build the control-plane's OWN handshake descriptor — the side the engine negotiates AGAINST each
 * worker (design §7.3). The CP advertises the protocol band it speaks so a worker stuck on an
 * incompatible major is detected instead of dispatched into (design §7.4). Capabilities default to
 * empty (the CP demands nothing of itself); `partition`/`namespace` scope it to a pool when set.
 *
 * The CP is not a worker, so `workflows`/`steps` are empty and `runtime` is `node`. `startedAt`
 * participates only in the descriptor hash (irrelevant for negotiation), so it defaults to `0` unless
 * a caller wants a stable identity.
 */
export function controlPlaneDescriptor(opts: {
  instanceId: string;
  /** SDK identity for observability (never gates dispatch). */
  sdk?: { name: string; version: string };
  /** Protocol majors the CP can negotiate. Defaults to the current single-major band `[v, v]`. */
  protocol?: { version: number; range: [number, number] };
  /** Capabilities the CP itself advertises (rarely needed; the CP is a router, not an executor). */
  capabilities?: string[];
  partition?: string | undefined;
  namespace?: string | undefined;
  startedAt?: number;
}): WorkerDescriptor {
  const version = CURRENT_PROTOCOL_VERSION;
  return {
    instanceId: opts.instanceId,
    runtime: 'node',
    sdk: opts.sdk ?? { name: '@agora/durable', version: String(version) },
    protocol: opts.protocol ?? { version, range: [version, version] },
    capabilities: opts.capabilities ?? [],
    workflows: [],
    steps: [],
    ...(opts.partition !== undefined ? { partition: opts.partition } : {}),
    ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
    startedAt: opts.startedAt ?? 0,
  };
}

/** The structured delta a blocked-dispatch diagnostics event carries (design §7.6) — enough for the
 *  telescope timeline + dashboard health panel to render exactly WHY nobody could run the work, never
 *  a bare boolean. Serializable (plain data), so it rides an `EngineEvent`/control-plane message. */
export interface DispatchDiagnostics {
  /** Which machine code fired — a missing capability vs. an unbridgeable protocol gap. */
  code: 'capability.unavailable' | 'protocol.incompatible';
  /** The routing token the work would have been dispatched to. */
  token: string;
  /** The capabilities the handler required (de-duplicated). */
  requires: string[];
  /** How many live workers were advertising on this token at decision time. */
  liveWorkers: number;
  /** Required capabilities NOT advertised by ANY live worker (the `capability.unavailable` delta). */
  missingCapabilities?: string[];
  /** The protocol band the control-plane speaks (the `protocol.incompatible` delta). */
  controlPlaneRange?: [number, number];
  /** Protocol bands of the capable-but-incompatible workers (the `protocol.incompatible` delta). */
  workerRanges?: [number, number][];
  /** The control-plane descriptor negotiated against (attached wholesale for observability). */
  controlPlane: WorkerDescriptor;
  /** The live worker descriptors considered (attached wholesale — the full picture on the timeline). */
  workers: WorkerDescriptor[];
}

/** At least one live worker can run the handler — dispatch proceeds as today. */
export interface RoutableDispatch {
  status: 'routable';
  /** The normalized subset that is BOTH capable and protocol-compatible. */
  workers: WorkerDescriptor[];
}

/** No live worker can run the handler — the engine parks the run `blocked` with this reason/delta. */
export interface BlockedDispatch {
  status: 'blocked';
  code: 'capability.unavailable' | 'protocol.incompatible';
  /** Dashboard/telescope copy, e.g. `blocked: no compatible worker (requires saga)`. */
  reason: string;
  requires: string[];
  diagnostics: DispatchDiagnostics;
}

export type DispatchPlan = RoutableDispatch | BlockedDispatch;

/**
 * Thrown from deep in a `ctx.step` dispatch when {@link planDispatch} returns `blocked`, so
 * the engine's run-execution catch can park the run `blocked` (with the carried plan) instead of
 * writing a `pending` checkpoint + dispatching into a queue no live worker consumes. Distinct from
 * `WorkflowSuspended` — a blocked run is re-driven by the blocked-recovery poll, not a durable timer.
 */
export class WorkflowBlocked extends Error {
  constructor(readonly plan: BlockedDispatch) {
    super(plan.reason);
    this.name = 'WorkflowBlocked';
  }
}

/**
 * Decide whether a handler requiring `requires` can be dispatched to a token whose LIVE fleet is
 * `liveDescriptors`, negotiating each candidate against the control-plane descriptor `cp`
 * (design §7.4/§7.5).
 *
 * A worker is dispatchable iff it is BOTH capability-capable ({@link canRoute}) AND
 * protocol-compatible ({@link negotiate} outcome ≠ `incompatible`). If ≥1 such worker exists →
 * `routable`. Otherwise `blocked`, with the reason discriminated:
 * - some workers had the capability but ALL are protocol-incompatible → `protocol.incompatible`;
 * - otherwise (no live worker advertises every required capability) → `capability.unavailable`.
 *
 * Precondition (enforced by the caller): `liveDescriptors` is NON-EMPTY. An empty fleet means "no
 * descriptors published" — the legacy/pre-handshake path — where the guard is intentionally skipped so
 * existing workers keep flowing (design §7.7); the engine never calls this with an empty fleet.
 */
export function planDispatch(
  requires: string[],
  liveDescriptors: readonly (RawWorkerDescriptor | WorkerDescriptor)[],
  cp: WorkerDescriptor,
  token: string,
): DispatchPlan {
  const required = requiredCapabilities({ requires });
  const workers = liveDescriptors.map(normalizeDescriptor);
  const capable = workers.filter((w) => canRoute({ requires }, w));
  const compatible = capable.filter((w) => negotiate(cp, w).outcome !== 'incompatible');

  if (compatible.length > 0) return { status: 'routable', workers: compatible };

  // Blocked. Which failure? Capable-but-incompatible → protocol; no capable at all → capability.
  if (capable.length > 0) {
    const workerRanges = capable.map((w) => w.protocol.range);
    return {
      status: 'blocked',
      code: 'protocol.incompatible',
      reason: `blocked: no protocol-compatible worker${
        required.length > 0 ? ` (requires ${required.join(', ')})` : ''
      }`,
      requires: required,
      diagnostics: {
        code: 'protocol.incompatible',
        token,
        requires: required,
        liveWorkers: workers.length,
        controlPlaneRange: cp.protocol.range,
        workerRanges,
        controlPlane: cp,
        workers,
      },
    };
  }

  // Capability gap: required caps advertised by NO live worker.
  const advertised = new Set(workers.flatMap((w) => w.capabilities));
  const missingCapabilities = required.filter((cap) => !advertised.has(cap));
  return {
    status: 'blocked',
    code: 'capability.unavailable',
    reason: `blocked: no compatible worker${
      required.length > 0 ? ` (requires ${required.join(', ')})` : ''
    }`,
    requires: required,
    diagnostics: {
      code: 'capability.unavailable',
      token,
      requires: required,
      liveWorkers: workers.length,
      missingCapabilities,
      controlPlane: cp,
      workers,
    },
  };
}

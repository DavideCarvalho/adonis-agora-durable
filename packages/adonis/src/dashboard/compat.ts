import { controlPlaneDescriptor } from '../dispatch-routing.js';
import type { WorkerDescriptor } from '../handshake/descriptor.js';
import { negotiate } from '../handshake/negotiate.js';
import type { WorkflowRun } from '../interfaces.js';
import type { RecordedBlock } from './diagnostics-recorder.js';
import { type ApiResponse, ok } from './handlers.js';

/**
 * The data source the {@link compat} health/compat handler reads (design §10). Deliberately a thin,
 * framework-light port so the handler is unit-testable with fakes:
 *
 * - `controlPlaneDescriptor()` — the control plane's own handshake descriptor, negotiated against each
 *   worker; `undefined` when nothing has advertised yet (the handler falls back to a current-protocol CP);
 * - `fleet()` — worker descriptors grouped by routing token: the LIVE green fleet enumerated off the
 *   transport ({@link enumerateLiveFleet}, so every advertising pod shows — compatible or not, blocked or
 *   not), merged with the descriptors {@link BlockedDiagnosticsRecorder} reconstructed from past blocks;
 * - `blockedRuns()` — the runs parked `blocked` (their human reason on `run.error.message`);
 * - `diagnosticsFor(runId)` — the captured loud delta for a blocked run, when one was recorded.
 *
 * The SAME handler serves a store-less `tenant` pod: there `fleet()` is empty and `diagnosticsFor` returns
 * nothing, so the panel still lists blocked runs (reason-only) round-tripped over the wire.
 */
export interface CompatSource {
  controlPlaneDescriptor(): WorkerDescriptor | undefined;
  fleet(): Array<{ token: string; workers: WorkerDescriptor[] }>;
  blockedRuns(): Promise<WorkflowRun[]>;
  diagnosticsFor(runId: string): RecordedBlock | undefined;
}

/** One routing token's live workers — the unit the compat panel negotiates per group. */
export type FleetGroup = { token: string; workers: WorkerDescriptor[] };

/**
 * The OPTIONAL transport capability the dashboard uses to enumerate the LIVE green fleet (design §7.2/§10) —
 * every worker currently advertising a descriptor, whether or not it has ever triggered a blocked dispatch.
 * Both methods are optional on the full `Transport` (only broker transports — e.g. bullmq — carry them), so
 * a transport that offers neither degrades the panel to the diagnostics-only view. Mirrors the engine's own
 * `listWorkerGroups`/`listWorkerDescriptors` narrowing.
 */
export interface FleetTransport {
  listWorkerGroups?(): Promise<string[]>;
  listWorkerDescriptors?(token: string): Promise<WorkerDescriptor[]>;
}

/**
 * Enumerate the LIVE fleet across ALL routing tokens: SCAN the heartbeat keyspace for distinct tokens
 * (`listWorkerGroups`), then read each token's advertised descriptors (`listWorkerDescriptors`). This is
 * what surfaces an incompatible worker that has NEVER blocked a dispatch — the diagnostics recorder only
 * knows workers a past block captured, but a green-fleet enumeration sees every live pod (compatible +
 * incompatible), so the panel can negotiate and red-flag it proactively.
 *
 * Degrades to `[]` (never throws): a transport without the capability, an empty keyspace, or a scan error
 * all read as "no live fleet", leaving the panel on its diagnostics-only view. A token whose workers are
 * all legacy (no descriptor published) contributes nothing — legacy is assume-compatible (design §7.7).
 */
export async function enumerateLiveFleet(
  transport: FleetTransport | null | undefined,
): Promise<FleetGroup[]> {
  if (
    !transport ||
    typeof transport.listWorkerGroups !== 'function' ||
    typeof transport.listWorkerDescriptors !== 'function'
  ) {
    return [];
  }
  const groups: FleetGroup[] = [];
  let tokens: string[];
  try {
    tokens = await transport.listWorkerGroups();
  } catch {
    return groups;
  }
  // Every token's descriptors read at once (each is its own SCAN round trip; the panel polls this),
  // then taken in token order.
  const listDescriptors = transport.listWorkerDescriptors.bind(transport);
  const reads = await Promise.allSettled(tokens.map(async (token) => listDescriptors(token)));
  for (const [i, token] of tokens.entries()) {
    const read = reads[i];
    // A backend that can't SCAN/GET the descriptor keyspace degrades to what was read before the
    // first failure — the panel still renders (diagnostics + any partial live view) rather than 500-ing.
    if (!read || read.status === 'rejected') break;
    if (read.value.length > 0) groups.push({ token, workers: read.value });
  }
  return groups;
}

/**
 * Union several fleet snapshots into one, keyed `token` → `instanceId`. Later sources WIN per instance, so
 * pass the freshest last (the provider passes the captured diagnostics fleet first, the live enumeration
 * last — a live descriptor supersedes a stale captured one, and a live-only worker with no prior block is
 * added). The result is what {@link CompatSource.fleet} returns for negotiation.
 */
export function mergeFleets(...sources: FleetGroup[][]): FleetGroup[] {
  const byToken = new Map<string, Map<string, WorkerDescriptor>>();
  for (const source of sources) {
    for (const { token, workers } of source) {
      const perInstance = byToken.get(token) ?? new Map<string, WorkerDescriptor>();
      for (const worker of workers) perInstance.set(worker.instanceId, worker);
      byToken.set(token, perInstance);
    }
  }
  return [...byToken].map(([token, perInstance]) => ({
    token,
    workers: [...perInstance.values()],
  }));
}

/**
 * `GET /compat` — the fleet health / protocol-compatibility panel (design §7.6, §10).
 *
 * Two sections, both LOUD and structured (never a bare boolean):
 * 1. **Per queue/group/pod compatibility** — every live worker descriptor negotiated against the control
 *    plane: its protocol version + the negotiated level, plus a red flag + the exact reason when
 *    incompatible ("no common protocol major: local speaks [1, 1], remote speaks [2, 2]").
 * 2. **Blocked runs** — runs parked because no worker can run them, each with its human reason and, when
 *    captured, the `capability.unavailable` / `protocol.incompatible` diagnostics delta (missing
 *    capabilities, the protocol ranges that failed to overlap).
 */
export async function compat(src: CompatSource): Promise<ApiResponse> {
  // Fall back to a current-protocol CP descriptor so pods can still be negotiated before the CP has
  // advertised (or on a topology that never publishes one).
  const cp =
    src.controlPlaneDescriptor() ?? controlPlaneDescriptor({ instanceId: 'control-plane' });

  const groups = src.fleet().map(({ token, workers }) => {
    const pods = workers.map((worker) => {
      const result = negotiate(cp, worker);
      return {
        instanceId: worker.instanceId,
        runtime: worker.runtime,
        sdk: worker.sdk,
        protocol: worker.protocol.version,
        protocolRange: worker.protocol.range,
        capabilities: worker.capabilities,
        outcome: result.outcome,
        negotiatedProtocol: result.negotiatedProtocol,
        incompatible: result.outcome === 'incompatible',
        // The red-flag reason: precise, structured copy for the panel (design §7.6). Absent when compatible.
        reason: result.reason?.message,
        missingOnRemote: result.capabilities.missingOnRemote,
        missingOnLocal: result.capabilities.missingOnLocal,
      };
    });
    return {
      token,
      pods,
      incompatible: pods.some((pod) => pod.incompatible),
      degraded: pods.some((pod) => pod.outcome === 'degraded'),
    };
  });

  const blocked = (await src.blockedRuns()).map((run) => {
    const recorded = src.diagnosticsFor(run.id);
    return {
      id: run.id,
      workflow: run.workflow,
      namespace: run.namespace,
      status: run.status,
      // Human reason: the persisted run error (always set when parked), or the captured delta's copy.
      reason: run.error?.message ?? recorded?.reason ?? 'blocked',
      code: recorded?.code,
      requires: recorded?.diagnostics.requires ?? [],
      // The structured delta (design §7.6), when a diagnostics event was captured for this run.
      token: recorded?.diagnostics.token,
      missingCapabilities: recorded?.diagnostics.missingCapabilities,
      controlPlaneRange: recorded?.diagnostics.controlPlaneRange,
      workerRanges: recorded?.diagnostics.workerRanges,
      updatedAt: run.updatedAt.toISOString(),
    };
  });

  const incompatibleCount = groups.reduce(
    (n, group) => n + group.pods.filter((pod) => pod.incompatible).length,
    0,
  );

  return ok({
    controlPlane: {
      instanceId: cp.instanceId,
      protocol: cp.protocol.version,
      protocolRange: cp.protocol.range,
      capabilities: cp.capabilities,
    },
    groups,
    blocked,
    incompatibleCount,
    blockedCount: blocked.length,
  });
}

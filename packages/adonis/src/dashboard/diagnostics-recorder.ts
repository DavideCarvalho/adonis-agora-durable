import type { DispatchDiagnostics } from '../dispatch-routing.js';
import type { WorkerDescriptor } from '../handshake/descriptor.js';
import type { EngineEvent } from '../interfaces.js';

/** The minimal engine surface the recorder subscribes to — a broad lifecycle-event stream. Both the
 *  concrete `WorkflowEngine` and any `DurableEventSource` satisfy it. */
export interface EngineEventSource {
  subscribe(listener: (event: EngineEvent) => void): () => void;
}

/**
 * A single captured LOUD diagnostics event (design §7.6) — the human reason plus the full structured
 * delta + descriptors the engine attached when it parked a run `blocked`. Enough for the dashboard
 * health panel to render exactly WHY nobody could run the work, never a bare boolean.
 */
export interface RecordedBlock {
  /** Which failure fired — a missing capability vs. an unbridgeable protocol gap. */
  code: 'capability.unavailable' | 'protocol.incompatible';
  /** Human one-liner (the run's `error.message`, e.g. `blocked: no compatible worker (requires saga)`). */
  reason: string;
  /** The precise routing delta + both descriptors (`DispatchDiagnostics`). */
  diagnostics: DispatchDiagnostics;
  /** When the block fired (ISO). */
  at: string;
}

/**
 * Captures the engine's `capability.unavailable` / `protocol.incompatible` diagnostics events (design
 * §7.6) into a bounded in-memory index the dashboard health panel reads (design §10, "fed by
 * descriptors + diagnostics events"). Since the loud events carry BOTH descriptors + the precise delta,
 * one subscription feeds the whole panel:
 *
 * - `diagnosticsFor(runId)` joins a `blocked` run to its captured delta (code, missing caps, ranges);
 * - `fleet()` reconstructs the live-fleet compat view — the worker descriptors last seen per routing
 *   token — so each pod can be re-negotiated against the control plane;
 * - `controlPlaneDescriptor()` is the CP side the events were negotiated against.
 *
 * Bounded by an LRU-ish cap on the per-run map (oldest evicted) so a long-lived control plane never
 * grows this without bound. Store-topology only: a `tenant` pod owns no engine to subscribe to, so its
 * panel shows `blocked` runs (reason from `run.error.message`) without the enriched delta.
 */
export class BlockedDiagnosticsRecorder {
  readonly #byRun = new Map<string, RecordedBlock>();
  /** token → (instanceId → latest descriptor). Latest-seen wins per instance. */
  readonly #fleet = new Map<string, Map<string, WorkerDescriptor>>();
  #controlPlane: WorkerDescriptor | undefined;
  readonly #max: number;

  constructor(opts: { max?: number } = {}) {
    this.#max = opts.max ?? 500;
  }

  /** Record one engine event; a no-op for anything but the two diagnostics types (or one missing its
   *  `diagnostics` payload). Idempotent per `runId` — a re-block overwrites with the freshest delta. */
  record(event: EngineEvent): void {
    if (event.type !== 'capability.unavailable' && event.type !== 'protocol.incompatible') return;
    const diagnostics = event.diagnostics;
    if (!diagnostics) return;

    // Bound the per-run index: evict the oldest insertion when a NEW run would exceed the cap.
    if (!this.#byRun.has(event.runId) && this.#byRun.size >= this.#max) {
      const oldest = this.#byRun.keys().next().value;
      if (oldest !== undefined) this.#byRun.delete(oldest);
    }
    // Re-insert at the end (freshest) so eviction stays roughly insertion-ordered.
    this.#byRun.delete(event.runId);
    this.#byRun.set(event.runId, {
      code: event.type,
      // The engine stamps the human reason on `error.message` when it parks the run (design §7.6).
      reason: event.error?.message ?? event.type,
      diagnostics,
      at: (event.at instanceof Date ? event.at : new Date(event.at)).toISOString(),
    });

    // Refresh the live-fleet snapshot for this token from the descriptors the event carried.
    const perToken = this.#fleet.get(diagnostics.token) ?? new Map<string, WorkerDescriptor>();
    for (const worker of diagnostics.workers) perToken.set(worker.instanceId, worker);
    this.#fleet.set(diagnostics.token, perToken);

    this.#controlPlane = diagnostics.controlPlane;
  }

  /** Subscribe to `source`'s lifecycle events; returns the unsubscribe fn (call it on shutdown). */
  attach(source: EngineEventSource): () => void {
    return source.subscribe((event) => this.record(event));
  }

  /** The captured delta for a `blocked` run, or `undefined` when none was recorded. */
  diagnosticsFor(runId: string): RecordedBlock | undefined {
    return this.#byRun.get(runId);
  }

  /** The control-plane descriptor the recorded events negotiated against, if any has been seen. */
  controlPlaneDescriptor(): WorkerDescriptor | undefined {
    return this.#controlPlane;
  }

  /** The live-fleet compat view: worker descriptors last seen per routing token. */
  fleet(): Array<{ token: string; workers: WorkerDescriptor[] }> {
    return [...this.#fleet].map(([token, byInstance]) => ({
      token,
      workers: [...byInstance.values()],
    }));
  }
}

import { type Admission, type AdmissionItem, type QueueConfig, QueueController } from './queue.js';

/**
 * Pluggable backend for the remote-step flow-control gate (`ctx.step(step, input, { queue })`). The
 * engine asks it whether a queued call may be admitted now (concurrency / rate / ordering) and tells
 * it when an admitted slot is released.
 *
 * The default {@link InMemoryAdmissionBackend} keeps per-instance counts — correct for a single
 * orchestrator. Swap in a store/Redis-backed backend to make the caps and ordering GLOBAL across
 * engine replicas (so `concurrency: 5` means 5 in-flight across the whole fleet, not 5 per pod).
 *
 * `tryAdmit`/`release` are async so a global backend can do its atomic round-trip; the in-memory one
 * resolves synchronously. An UNREGISTERED queue name is treated as ungated (admits immediately) — the
 * engine only tracks/releases a slot for a registered queue.
 */
export interface AdmissionBackend {
  /** Register (or replace) a queue's config. Called from `engine.registerQueue`. */
  register(config: QueueConfig): void;
  /** Whether `queue` is registered (gated). The engine only tracks/releases a slot for a gated queue. */
  handles(queue: string): boolean;
  /** May a call on `queue` take a slot now? On `ok`, the caller holds a slot until {@link release}. */
  tryAdmit(queue: string, item: AdmissionItem): Promise<Admission>;
  /**
   * Release the slot granted by {@link tryAdmit} for `queue`. `slotId` is the admitted item's
   * `waiterId` (the engine's stepId), so a lease-based backend can drop the exact slot; an in-process
   * counter ignores it.
   */
  release(queue: string, slotId: string): Promise<void>;
  /**
   * Optional: subscribe to "a slot just freed on `queue`" events (e.g. a fleet-wide pub/sub). The
   * engine uses it to wake its admission-blocked runs early instead of waiting for their retry tick.
   * A backend without it falls back to retry-tick polling. Fired best-effort across the fleet.
   */
  onFreed?(handler: (queue: string) => void): void;
}

/**
 * Default admission backend: one in-process {@link QueueController} per registered queue. Caps and
 * waiter ordering are per engine instance (see {@link QueueConfig}). Preserves the exact pre-backend
 * behaviour — the engine used to hold these controllers directly.
 */
export class InMemoryAdmissionBackend implements AdmissionBackend {
  private readonly controllers = new Map<string, QueueController>();

  constructor(private readonly clock: () => number) {}

  register(config: QueueConfig): void {
    this.controllers.set(config.name, new QueueController(config, this.clock));
  }

  handles(queue: string): boolean {
    return this.controllers.has(queue);
  }

  async tryAdmit(queue: string, item: AdmissionItem): Promise<Admission> {
    const controller = this.controllers.get(queue);
    // Unregistered queue → ungated (mirrors the old `this.queues.get(queue)` truthiness check).
    if (!controller) return { ok: true };
    return controller.tryAdmit(item);
  }

  async release(queue: string, _slotId: string): Promise<void> {
    this.controllers.get(queue)?.release();
  }
}

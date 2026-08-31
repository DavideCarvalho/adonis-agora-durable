import type {
  ControlMessage,
  ControlPlane,
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowStepEvent,
} from '../interfaces.js';
import { runStepHandler, type StepHandler } from '../protocol.js';

/**
 * An in-process `Transport` (and `ControlPlane`) for tests and local development: registered
 * handlers stand in for remote workers, so a whole cross-app workflow runs in a single process,
 * and control messages broadcast locally. Pass the same instance as both `transport` and
 * `controlPlane`.
 */
export class InMemoryTransport implements Transport, ControlPlane {
  private readonly handlers = new Map<string, StepHandler>();
  private resultHandler?: (result: StepResult) => Promise<void>;
  private stepEventHandler?: (event: WorkflowStepEvent) => Promise<void>;
  private readonly controlHandlers = new Set<(msg: ControlMessage) => void>();
  /** The engine's namespace, recorded for parity. This transport is a single isolated instance (its
   *  own handlers + result handler), so two engines never share one bus here — namespacing is a safe
   *  no-op, but the hook lets the engine's `pool.useNamespace(...)` apply uniformly across transports. */
  private namespace: string | undefined;

  /** Adopt the engine's namespace (no-op isolation — see {@link namespace}). */
  useNamespace(namespace: string): void {
    this.namespace = namespace;
  }

  /** Register a fake worker handler for a step name. */
  handle(name: string, fn: StepHandler): void {
    this.handlers.set(name, fn);
  }

  async dispatch(task: RemoteTask): Promise<void> {
    if (!this.resultHandler) throw new Error('no result handler registered');
    const result = await runStepHandler(task, this.handlers.get(task.name));
    // Deliver the result ASYNCHRONOUSLY, not inline: a durable `ctx.step` suspends the run right
    // after dispatch, so the result must land AFTER that unwinds (else the resume re-enters
    // mid-suspend). Real brokers are async; this mirrors them.
    setImmediate(() => void this.resultHandler?.(result));
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {
    // In-process handlers run synchronously; there is no liveness to track.
  }

  /** Workflow step lifecycle: deliver to the engine's handler (async, mirroring a real broker). */
  async dispatchStepEvent(event: WorkflowStepEvent): Promise<void> {
    await this.stepEventHandler?.(event);
  }

  onStepEvent(handler: (event: WorkflowStepEvent) => Promise<void>): void {
    this.stepEventHandler = handler;
  }

  // Control plane: broadcast to every registered handler (including the publisher's own — the
  // engine dedupes by `from`), mirroring how a real broker echoes a publish to all subscribers.
  async publishControl(msg: ControlMessage): Promise<void> {
    for (const handler of this.controlHandlers) handler(msg);
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.controlHandlers.add(handler);
  }
}

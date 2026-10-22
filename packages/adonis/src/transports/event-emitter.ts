import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WorkerDescriptor } from '../handshake/descriptor.js';
import {
  type ControlMessage,
  type ControlPlane,
  type Heartbeat,
  type RemoteTask,
  type StepResult,
  type Transport,
} from '../interfaces.js';
import { runStepHandler, type StepHandler } from '../protocol.js';
import type { DescriptorRedis } from '../worker-runtime/registry.js';
import { descriptorsOn, liveGroupsOf, MemoryWorkerKeys, workerKeyWriter } from './worker-keys.js';

/** Event names the transport multiplexes over a single in-process emitter. */
export const TASK_EVENT = 'durable.task';
export const RESULT_EVENT = 'durable.result';
export const HEARTBEAT_EVENT = 'durable.heartbeat';
export const CONTROL_EVENT = 'durable.control';

export interface EventEmitterTransportOptions {
  /**
   * The in-process emitter to multiplex over. Defaults to a fresh Node `EventEmitter` (listener cap
   * lifted, since the engine wires several long-lived listeners). Pass `@adonisjs/core`'s `emitter`
   * service if you'd rather ride the app's bus — it is API-compatible for `on`/`emit`.
   */
  emitter?: EventEmitter;
  /**
   * The worker group this instance serves. Unused for routing (handlers are matched by step name in
   * this same process) — accepted for parity with the broker transports, and stamped nowhere.
   */
  group?: string;
  /**
   * Logical deployment namespace, folded into the internal event-channel names so two namespaces over
   * ONE shared in-process emitter don't cross-process each other's tasks/results. `"default"` (and
   * absent) keeps the channel names BYTE-IDENTICAL to the un-namespaced scheme; any other value
   * appends a `:<namespace>` segment. Explicit here wins over a later {@link EventEmitterTransport.useNamespace}.
   */
  namespace?: string;
  /** Stable id for this process (stamped on control `from` when a publisher leaves it unset). Default random. */
  instanceId?: string;
  /**
   * Where a failing result/heartbeat handler is reported. Default `console.error`. A result whose
   * handler threw (a store error while settling the checkpoint) is redelivered with backoff — the
   * in-memory copy is the only one, as on a broker whose job stays queued until it is settled.
   */
  onError?: (err: unknown) => void;
}

/** The minimal `on`/`emit` surface this transport needs — satisfied by Node's `EventEmitter` and
 *  `@adonisjs/core`'s emitter alike, so neither is a hard dependency. */
type EmitterLike = Pick<EventEmitter, 'on' | 'emit'>;

// The worker advertisement keys, one board per emitter: every transport over the same in-process bus
// (an engine's and a worker runtime's) reads and writes the same keys.
const workerKeysByEmitter = new WeakMap<EmitterLike, MemoryWorkerKeys>();

/** Backoff for redelivering a result whose handler failed: 100ms doubling, capped at 5s. */
const RESULT_RETRY_BASE_MS = 100;
const RESULT_RETRY_MAX_MS = 5_000;

/**
 * A production **in-process** {@link Transport} (and {@link ControlPlane}) backed by a single Node
 * `EventEmitter`. Zero external infrastructure (no DB, no Redis, no broker): step handlers run in the
 * same process, fully decoupled from the workflow that dispatched them, so a single-process app runs
 * real durable workflows with nothing else to deploy.
 *
 * Distinct from the test-only {@link import('../testing/in-memory-transport.js').InMemoryTransport}:
 * that one drives `dispatch` straight into the handler (synchronous-ish, for deterministic tests);
 * this one decouples both directions through the emitter's event loop, mirroring how a real broker
 * fans dispatch → worker → result back. Both funnel every step through {@link runStepHandler}, so the
 * scoped context restore (the `@agora/context:scope` slot) works identically here.
 *
 * Swap to {@link import('./db.js').DbTransport} / {@link import('./queue.js').QueueTransport} for
 * true cross-process or cross-language steps. The {@link ControlPlane} here broadcasts locally (every
 * subscriber in this process), correct for single-instance; it does NOT fan out across pods.
 *
 * Usually you don't construct this directly: `config/durable.ts` selects it via
 * `transports.eventEmitter()` (alias `transports.memory()` from the factory points at the test
 * transport) and the provider builds it for you.
 */
export class EventEmitterTransport implements Transport, ControlPlane {
  readonly #emitter: EmitterLike;
  readonly #instanceId: string;
  readonly #onError: (err: unknown) => void;
  #closed = false;
  readonly #handlers = new Map<string, StepHandler>();
  // Logical deployment namespace folded into every channel name via `#suffix()`. Mutable so an engine
  // can push its namespace via `useNamespace()` — but only when one wasn't passed explicitly to the
  // constructor (`#explicitNamespace`), which always wins.
  #namespace: string | undefined;
  readonly #explicitNamespace: boolean;
  // Whether the worker-side task listener is subscribed yet. Subscription is LAZY (on first `handle()`)
  // so the namespace the engine pushes via `useNamespace()` (before any handler registration) is the
  // one the listener binds to — an engine-only instance with no handlers never subscribes.
  #subscribed = false;

  constructor(options: EventEmitterTransportOptions = {}) {
    // A long-lived single emitter carries several engine listeners; lift Node's default cap so the
    // engine wiring (result + heartbeat + control + task) never trips a MaxListenersExceededWarning.
    const emitter = options.emitter ?? new EventEmitter();
    if (emitter instanceof EventEmitter) emitter.setMaxListeners(0);
    this.#emitter = emitter;
    this.#instanceId = options.instanceId ?? randomUUID();
    this.#onError =
      options.onError ?? ((err) => console.error('[EventEmitterTransport] handler failed', err));
    this.#namespace = options.namespace;
    this.#explicitNamespace = options.namespace !== undefined;
  }

  /** Stable id stamped on control `from` when a publisher leaves it unset. */
  get instanceId(): string {
    return this.#instanceId;
  }

  /**
   * Adopt `namespace` (the engine's, typically), segmenting the internal channel names — but ONLY if a
   * namespace wasn't passed explicitly to the constructor (an explicit one always wins). Idempotent.
   * Safe before subscription (the task listener binds lazily on the first `handle()`, after this runs).
   */
  useNamespace(namespace: string): void {
    if (this.#explicitNamespace) return;
    this.#namespace = namespace;
  }

  /** Non-`"default"` namespaces append a `:<namespace>` channel segment; default/absent stays bare so
   *  the un-namespaced channel names are byte-identical. */
  #suffix(): string {
    return this.#namespace && this.#namespace !== 'default' ? `:${this.#namespace}` : '';
  }

  // ---------------------------------------------------------------------------
  // engine → worker
  // ---------------------------------------------------------------------------

  async dispatch(task: RemoteTask): Promise<void> {
    this.#emitter.emit(`${TASK_EVENT}${this.#suffix()}`, task);
  }

  // ---------------------------------------------------------------------------
  // worker side — register a step handler, run it, emit the result back
  // ---------------------------------------------------------------------------

  /** Register a step handler by name (the worker side, in this same process). Subscribes the task
   *  listener on the first call — bound to the (now-resolved) namespaced channel — so the worker side
   *  listens for every dispatched task and runs it if it owns the step name. */
  handle(name: string, fn: StepHandler): void {
    this.#handlers.set(name, fn);
    if (!this.#subscribed) {
      this.#subscribed = true;
      this.#emitter.on(`${TASK_EVENT}${this.#suffix()}`, (task: RemoteTask) => {
        void this.#process(task);
      });
    }
  }

  /** Worker side: a liveness heartbeat. In-process handlers run synchronously, so emit it straight
   *  through for symmetry — an engine that wired `onHeartbeat` still observes it. */
  async heartbeat(beat: Heartbeat): Promise<void> {
    this.#emitter.emit(`${HEARTBEAT_EVENT}${this.#suffix()}`, beat);
  }

  async #process(task: RemoteTask): Promise<void> {
    const handler = this.#handlers.get(task.name);
    // Another subscriber may own this step name — stay silent, don't synthesize a "no handler" failure.
    if (!handler) return;
    const result = await runStepHandler(task, handler, (beat) => this.heartbeat(beat));
    // Emit the result on a LATER tick: a durable `ctx.step` suspends the run right after dispatch, so
    // the result must land AFTER that unwinds (else the resume re-enters mid-suspend). Real brokers
    // deliver asynchronously; this mirrors them.
    setImmediate(() => this.#emitter.emit(`${RESULT_EVENT}${this.#suffix()}`, result));
  }

  // ---------------------------------------------------------------------------
  // worker → engine — the engine consumes results + heartbeats
  // ---------------------------------------------------------------------------

  /** Stop redelivering failed results (the provider calls it on shutdown). Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.#emitter.on(`${RESULT_EVENT}${this.#suffix()}`, (result: StepResult) => {
      this.#settle(handler, result, 0);
    });
  }

  /**
   * Hand `result` to the engine; if settling fails, report it and try again with backoff. The handler
   * used to be called as `void handler(result)`: a rejection (the store briefly unreachable while the
   * checkpoint is written) became an unhandled rejection — fatal under Node's default — and the result,
   * whose only copy lived in this call, was lost. The engine's settle is idempotent per step, so a retry
   * after a partial write is safe. Retries stop once the transport is closed.
   */
  #settle(
    handler: (result: StepResult) => Promise<void>,
    result: StepResult,
    attempt: number,
  ): void {
    Promise.resolve()
      .then(() => handler(result))
      .catch((err) => {
        this.#onError(err);
        if (this.#closed) return;
        const delay = Math.min(RESULT_RETRY_BASE_MS * 2 ** attempt, RESULT_RETRY_MAX_MS);
        const timer = setTimeout(() => this.#settle(handler, result, attempt + 1), delay);
        timer.unref?.();
      });
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.#emitter.on(`${HEARTBEAT_EVENT}${this.#suffix()}`, (beat: Heartbeat) => {
      // A lost beat only costs liveness for one interval; report it rather than crash the process.
      Promise.resolve()
        .then(() => handler(beat))
        .catch((err) => this.#onError(err));
    });
  }

  // ---------------------------------------------------------------------------
  // control plane (broadcast within this process)
  // ---------------------------------------------------------------------------

  async publishControl(msg: ControlMessage): Promise<void> {
    const stamped: ControlMessage = msg.from ? msg : { ...msg, from: this.#instanceId };
    this.#emitter.emit(`${CONTROL_EVENT}${this.#suffix()}`, stamped);
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.#emitter.on(`${CONTROL_EVENT}${this.#suffix()}`, (msg: ControlMessage) => handler(msg));
  }
  // ---------------------------------------------------------------------------
  // worker advertisement (design §7.2) — kept in memory, shared by the emitter's transports
  // ---------------------------------------------------------------------------

  #workerKeys(): MemoryWorkerKeys {
    let keys = workerKeysByEmitter.get(this.#emitter);
    if (!keys) {
      keys = new MemoryWorkerKeys();
      workerKeysByEmitter.set(this.#emitter, keys);
    }
    return keys;
  }

  /** The writer a worker runtime's registry advertises its descriptor and heartbeat through. */
  createDescriptorRedis(): DescriptorRedis {
    return workerKeyWriter(this.#workerKeys(), Date.now);
  }

  /** The live worker descriptors advertised on `token`. */
  async listWorkerDescriptors(token: string): Promise<WorkerDescriptor[]> {
    return descriptorsOn(await this.#workerKeys().live(Date.now()), token);
  }

  /** The routing tokens a live worker beats on. */
  async listWorkerGroups(): Promise<string[]> {
    return liveGroupsOf(await this.#workerKeys().live(Date.now()));
  }
}

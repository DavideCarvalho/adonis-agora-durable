import {
  CURRENT_PROTOCOL_VERSION,
  heartbeatStatus,
  type WorkerDescriptor,
  type WorkerLifecycle,
} from '../handshake/descriptor.js';
import type { WorkflowStepEvent } from '../interfaces.js';
import type { StepHandler } from '../protocol.js';
import {
  buildInstanceId,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '../transports/bullmq/serialization.js';
import { runWorkflowTurn, type WorkflowBody, type WorkflowTurnHandler } from '../workflow-turn.js';
import {
  effectivePrefix,
  routingToken,
  workerDescriptorKey,
  workerHeartbeatKey,
} from './naming.js';
import { NoopWorkerRegistry, type WorkerRegistry } from './registry.js';

/**
 * The bare worker surface the {@link WorkerRuntime} consumes tasks over — exactly `handle(name, fn)`
 * (the wave-1 BullMQTransport / any `StepServer` satisfies it) plus an optional `close`. Typed this
 * narrowly (not the full `Transport`) so the store-less runtime depends only on what it uses: the
 * transport owns the consume→`runStepHandler`→publish-result loop; the runtime wires handlers onto it
 * and advertises what it serves.
 */
export interface WorkerTransport {
  /** Register a step handler → the transport subscribes `${P}-tasks-<token>` for it and, on a task,
   *  runs it through the shared `protocol.ts runStepHandler` and publishes the {@link StepResult}. */
  handle(name: string, fn: StepHandler): void;
  /** Register a WORKFLOW turn consumer → the transport subscribes the workflow name's
   *  `${P}-tasks-<token>` queue and, on a `workflow`-shaped job (discriminated by SHAPE, spec §6.3),
   *  runs `turn(task)` (the replay → decision) and publishes the {@link WorkflowDecision} on
   *  `${P}-decisions`. OPTIONAL — a transport that can't carry workflow tasks omits it, and the runtime
   *  then only advertises the workflow name (routing/observability) without executing turns. */
  handleWorkflow?(name: string, turn: WorkflowTurnHandler): void;
  /** workflow worker → engine: stream a LOCAL step's lifecycle ({@link WorkflowStepEvent}) mid-turn so a
   *  long inline turn's steps show live. OPTIONAL — only broker transports carry it; absent = no live
   *  step streaming (the turn's final decision still records every step). */
  dispatchStepEvent?(event: WorkflowStepEvent): Promise<void>;
  /** Release the transport's broker workers/connections on stop. Optional (in-process transports omit it). */
  close?(): Promise<void>;
}

/** Where the runtime narrates its lifecycle. Defaults to a silent logger. */
export interface WorkerRuntimeLogger {
  info(message: string): void;
  error(message: string): void;
}

/** SDK identity stamped on the descriptor when the caller doesn't override it (observability only). */
export const WORKER_SDK = { name: '@adonis-agora/durable', version: '0.9.0' } as const;

export interface WorkerRuntimeOptions {
  /** The broker the worker consumes tasks over (wave-1 `BullMQTransport`, or any `handle`-able server). */
  transport: WorkerTransport;
  /** Which tenant/partition this pod serves — suffixes every routing token (`<name>@<partition>`) and
   *  tags the descriptor. Required (a store-less worker always belongs to a partition). */
  partition: string;
  /** Deployment namespace segmenting every key/queue. Absent or `"default"` keeps names byte-identical. */
  namespace?: string;
  /** Key prefix namespacing the durable queues/keys. Default `durable`. */
  prefix?: string;
  /** Stable per-process id stamped on the liveness/descriptor keys. Default `ts-<host>-<pid>`. MUST
   *  match the transport's instance id so the two-tier keys correlate. */
  instanceId?: string;
  /** SDK identity advertised in the descriptor (observability only; never gates dispatch). */
  sdk?: { name: string; version: string };
  /** Extra advertised features beyond registered handler names (design §7.1 `capabilities`). */
  capabilities?: string[];
  /** Descriptor/heartbeat advertiser. Default {@link NoopWorkerRegistry} (descriptor still built +
   *  observable via {@link WorkerRuntime.descriptor}, just not published). Pass a `RedisWorkerRegistry`
   *  to advertise on the shared Redis. */
  registry?: WorkerRegistry;
  /** Worker-liveness beat cadence (ms). Default 10s (aviary `WORKER_HEARTBEAT_INTERVAL_MS`). */
  heartbeatIntervalMs?: number;
  /** TTL (s) on the descriptor + heartbeat keys. Default 35s (aviary `WORKER_HEARTBEAT_TTL_SECONDS`). */
  ttlSeconds?: number;
  /** Clock for the heartbeat `ts` (injectable for a deterministic test). Default `Date.now`. */
  now?: () => number;
  logger?: WorkerRuntimeLogger;
  /** Where a background advertisement/beat failure is reported (best-effort — the key just expires). */
  onError?: (err: unknown) => void;
}

const SILENT_LOGGER: WorkerRuntimeLogger = { info: () => {}, error: () => {} };

/**
 * A **store-less** worker runtime (design §4): it executes step bodies pulled off the transport and
 * advertises what it can serve — and has, by construction, NO store field and imports NO Lucid (proven
 * by the `no-lucid` structural test). It is deliberately NOT a store-optional engine: isolation is a
 * structural fact, not a runtime `if (this.store)`.
 *
 * Responsibilities:
 * - **Register handlers** — {@link registerStep} (also `handle`, so `step-discovery`'s
 *   `registerStepsFromDir/Barrel` can target the runtime directly) forwards to `transport.handle`,
 *   which subscribes `${P}-tasks-<token>` and runs each task through the shared `runStepHandler`,
 *   publishing the result. Workflow NAMES ({@link registerWorkflowName}) populate the descriptor.
 * - **Advertise** ({@link start}) — publishes the {@link WorkerDescriptor} to
 *   `${P}-worker-descriptor:<token>:<instance>` and beats the compact `{ ts, status, descriptorHash }`
 *   to `${P}-worker-heartbeat:<token>:<instance>` on a schedule (design §7.2 two-tier ETag scheme).
 *
 * It holds no store and reads none — every durable decision stays on the control-plane; this object
 * only runs bodies and says who it is.
 */
export class WorkerRuntime {
  readonly #transport: WorkerTransport;
  readonly #partition: string;
  readonly #namespace: string | undefined;
  readonly #prefix: string;
  readonly #instanceId: string;
  readonly #sdk: { name: string; version: string };
  readonly #capabilities: string[];
  readonly #registry: WorkerRegistry;
  readonly #heartbeatIntervalMs: number;
  readonly #ttlSeconds: number;
  readonly #now: () => number;
  readonly #logger: WorkerRuntimeLogger;
  readonly #onError: (err: unknown) => void;

  readonly #steps = new Set<string>();
  readonly #workflows = new Set<string>();
  // Worker-side workflow turn bodies, keyed by name — the resolver `runWorkflowTurn` replays against.
  readonly #workflowBodies = new Map<string, WorkflowBody>();
  readonly #startedAt: number;

  #beatTimer: ReturnType<typeof setInterval> | undefined;
  #started = false;

  constructor(options: WorkerRuntimeOptions) {
    this.#transport = options.transport;
    this.#partition = options.partition;
    this.#namespace = options.namespace;
    this.#prefix = options.prefix ?? 'durable';
    this.#instanceId = options.instanceId ?? buildInstanceId();
    this.#sdk = options.sdk ?? { ...WORKER_SDK };
    this.#capabilities = [...(options.capabilities ?? [])];
    this.#registry = options.registry ?? new NoopWorkerRegistry();
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS;
    this.#ttlSeconds = options.ttlSeconds ?? WORKER_HEARTBEAT_TTL_SECONDS;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger ?? SILENT_LOGGER;
    this.#onError = options.onError ?? (() => {});
    // Process start time — a restart changes it, so the descriptor hash (and thus the ETag) changes.
    this.#startedAt = this.#now();
  }

  /** Stable id stamped on this instance's liveness/descriptor keys. */
  get instanceId(): string {
    return this.#instanceId;
  }

  /** The step handler names this worker serves (sorted). */
  get stepNames(): string[] {
    return [...this.#steps].sort();
  }

  /** The workflow names this worker advertises (sorted). */
  get workflowNames(): string[] {
    return [...this.#workflows].sort();
  }

  /**
   * Register a step handler on the transport (which subscribes its `${P}-tasks-<token>` queue and runs
   * each task through the shared `runStepHandler`) AND record its name for the descriptor. Named
   * `handle` too so `step-discovery`'s `registerStep`/`registerStepsFromDir`/`registerStepsFromBarrel`
   * can target the runtime directly (it satisfies their `StepServer`). Re-registering swaps the handler;
   * if already {@link start}ed, the descriptor is re-advertised so the new name is routable.
   */
  handle(name: string, fn: StepHandler): void {
    this.#transport.handle(name, fn);
    const isNew = !this.#steps.has(name);
    this.#steps.add(name);
    if (isNew && this.#started) void this.#advertise();
  }

  /** Alias of {@link handle} reading as intent at a call site that isn't the discovery `StepServer`. */
  registerStep(name: string, fn: StepHandler): void {
    this.handle(name, fn);
  }

  /**
   * Register a runnable WORKFLOW TURN body (`(ctx, input) => output`, written against the worker-side
   * {@link import('../workflow-turn.js').WorkflowTurnCtx}) AND advertise its name. This is what lets a
   * store-less TS worker EXECUTE workflow turns for parity with a Python worker (design §4): the
   * transport subscribes the workflow's `${P}-tasks-<token>` queue and, on a `workflow`-shaped job, the
   * turn is replayed via the shared {@link runWorkflowTurn} (deterministic history → decision) and the
   * {@link import('../interfaces.js').WorkflowDecision} published on `${P}-decisions`. The worker never
   * touches a store — every durable decision stays on the control-plane; this only replays the body.
   *
   * NOTE: this is the polyglot TURN surface (the TS twin of the Python `@workflow`), NOT the
   * store-backed `BaseWorkflow`/`WorkflowCtx` the engine runs in-process — those are a different
   * authoring surface (they own the store). Re-registering swaps the body; if the transport can't carry
   * workflow tasks (`handleWorkflow` absent) the name is still advertised, just not executed here.
   */
  registerWorkflow(name: string, body: WorkflowBody): void {
    const firstBody = !this.#workflowBodies.has(name);
    this.#workflowBodies.set(name, body);
    // Wire the transport's turn consumer ONCE per name (the resolver reads the live #workflowBodies map,
    // so a later re-register is picked up without re-wiring). No-op if the transport can't carry turns.
    if (firstBody && this.#transport.handleWorkflow) {
      this.#transport.handleWorkflow(name, (task) =>
        runWorkflowTurn(this.#workflowBodies, task, {
          partition: this.#partition,
          ...(this.#transport.dispatchStepEvent
            ? {
                onStep: (event: WorkflowStepEvent) =>
                  void this.#transport.dispatchStepEvent?.(event),
              }
            : {}),
        }),
      );
    }
    const isNew = !this.#workflows.has(name);
    this.#workflows.add(name);
    if (isNew && this.#started) void this.#advertise();
  }

  /**
   * Advertise a workflow NAME in the descriptor WITHOUT a runnable body (routing + capability
   * negotiation only, design §7.1) — e.g. this pod routes/observes a workflow another worker executes.
   * To actually EXECUTE turns here, use {@link registerWorkflow}. If already {@link start}ed,
   * re-advertises so the name is visible.
   */
  registerWorkflowName(name: string): void {
    const isNew = !this.#workflows.has(name);
    this.#workflows.add(name);
    if (isNew && this.#started) void this.#advertise();
  }

  /** Advertise many workflow names at once (one re-advertise). */
  registerWorkflowNames(names: Iterable<string>): void {
    let added = false;
    for (const name of names) {
      if (!this.#workflows.has(name)) added = true;
      this.#workflows.add(name);
    }
    if (added && this.#started) void this.#advertise();
  }

  /**
   * The worker's current {@link WorkerDescriptor} — the single source of truth for routing, compat and
   * observability (design §7.1). `workflows`/`steps` are the registered handler names (sorted, a set);
   * `capabilities` are the configured extra features; `protocol` is the current major with a `[1, N]`
   * range. Rebuilt on each read so it always reflects what is registered right now.
   */
  descriptor(): WorkerDescriptor {
    return {
      instanceId: this.#instanceId,
      runtime: 'node',
      sdk: { ...this.#sdk },
      protocol: { version: CURRENT_PROTOCOL_VERSION, range: [1, CURRENT_PROTOCOL_VERSION] },
      capabilities: [...this.#capabilities],
      workflows: [...this.#workflows].sort(),
      steps: [...this.#steps].sort(),
      ...(this.#partition ? { partition: this.#partition } : {}),
      ...(this.#namespace !== undefined ? { namespace: this.#namespace } : {}),
      startedAt: this.#startedAt,
    };
  }

  /** The `${P}-worker-descriptor:<token>:<instance>` / `${P}-worker-heartbeat:<token>:<instance>` keys
   *  this worker owns — one per DISTINCT routing token across its registered steps + workflows. */
  #tokens(): string[] {
    const tokens = new Set<string>();
    for (const name of this.#steps) tokens.add(routingToken(name, this.#partition));
    for (const name of this.#workflows) tokens.add(routingToken(name, this.#partition));
    return [...tokens];
  }

  #effPrefix(): string {
    return effectivePrefix(this.#prefix, this.#namespace);
  }

  /** Publish the full descriptor under every handled token's descriptor key (design §7.2). */
  async #advertise(): Promise<void> {
    const descriptor = this.descriptor();
    const effPrefix = this.#effPrefix();
    try {
      await Promise.all(
        this.#tokens().map((token) =>
          this.#registry.advertiseDescriptor({
            key: workerDescriptorKey(effPrefix, token, this.#instanceId),
            descriptor,
            ttlSeconds: this.#ttlSeconds,
          }),
        ),
      );
    } catch (err) {
      this.#onError(err);
    }
  }

  /** Beat the compact `{ ts, status, descriptorHash }` under every handled token's heartbeat key. */
  async #beat(status: WorkerLifecycle): Promise<void> {
    const descriptor = this.descriptor();
    const beat = heartbeatStatus(descriptor, { ts: this.#now(), status });
    const effPrefix = this.#effPrefix();
    try {
      await Promise.all(
        this.#tokens().map((token) =>
          this.#registry.beat({
            key: workerHeartbeatKey(effPrefix, token, this.#instanceId),
            status: beat,
            ttlSeconds: this.#ttlSeconds,
          }),
        ),
      );
    } catch (err) {
      this.#onError(err);
    }
  }

  /**
   * Begin advertising: publish the descriptor + do the first heartbeat immediately (so a freshly
   * started worker is visible without waiting a full interval), then refresh both on the heartbeat
   * schedule. Idempotent. The interval is `unref`'d so it never keeps the process alive on its own.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#advertise();
    await this.#beat('up');
    this.#beatTimer = setInterval(() => {
      // Re-advertise each cycle too: refreshes the descriptor key's TTL (cheap; the ETag is stable so a
      // reader still skips the re-read) so it never expires under a live worker.
      void this.#advertise();
      void this.#beat('up');
    }, this.#heartbeatIntervalMs);
    this.#beatTimer.unref?.();
    this.#logger.info(
      `worker-runtime started (instance ${this.#instanceId}, partition ${this.#partition}, ` +
        `${this.#steps.size} steps, ${this.#workflows.size} workflows)`,
    );
  }

  /**
   * Stop advertising and release resources: clears the beat interval, best-effort removes this
   * instance's keys (a graceful drain — a watcher sees the worker leave immediately, not on TTL
   * expiry), then closes the registry's owned connection and the transport. Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    if (this.#beatTimer) clearInterval(this.#beatTimer);
    this.#beatTimer = undefined;

    if (this.#registry.remove) {
      const effPrefix = this.#effPrefix();
      const keys = this.#tokens().flatMap((token) => [
        workerDescriptorKey(effPrefix, token, this.#instanceId),
        workerHeartbeatKey(effPrefix, token, this.#instanceId),
      ]);
      try {
        await this.#registry.remove(keys);
      } catch (err) {
        this.#onError(err);
      }
    }
    await this.#registry.close?.();
    await this.#transport.close?.();
    this.#logger.info(`worker-runtime stopped (instance ${this.#instanceId})`);
  }
}

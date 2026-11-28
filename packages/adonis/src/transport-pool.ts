import type { WorkerDescriptor } from './handshake/descriptor.js';
import type {
  GroupHealth,
  Heartbeat,
  NamedTransport,
  OnDemandTransports,
  RemoteTask,
  StepResult,
  Transport,
  WorkerHeartbeat,
  WorkflowStepEvent,
} from './interfaces.js';

/** Most tasks {@link TransportPool.dispatchMany} dispatches at once when it sends them one by one. */
const DISPATCH_CHUNK = 200;

type ResultHandler = (result: StepResult) => Promise<void>;
type HeartbeatHandler = (beat: Heartbeat) => Promise<void>;
type StepEventHandler = (event: WorkflowStepEvent) => Promise<void>;

/**
 * An ordered pool of named transports. The engine dispatches on the first and fails over to the
 * next on a dispatch error; a step can pin one by id. Pure transport plumbing — no run lifecycle —
 * so it lives apart from the engine.
 *
 * With {@link OnDemandTransports}, a pin to an id the pool does not hold yet builds that transport
 * on first use and appends it, after the transports the pool was constructed with. Everything the
 * pool did to its members (namespace, handlers, reply routing, consumer start) is replayed on it.
 */
export class TransportPool {
  private warnedBulkRefusal = false;
  /** Ids of the transports that route replies to this engine instance (see {@link routeReplies}). */
  private readonly replying = new Set<string>();
  private readonly transports: NamedTransport[];
  /** In-flight on-demand builds by id, shared by concurrent first uses; dropped once settled. */
  private readonly building = new Map<string, Promise<void>>();
  /** Ids built on demand, in build order. */
  private readonly builtOnDemand: string[] = [];
  /** What was applied to the members, replayed on a transport built later. */
  private namespace: string | undefined;
  private handlers: [ResultHandler, HeartbeatHandler, StepEventHandler | undefined] | undefined;
  private replyInstance: string | undefined;
  private consumersStarted = false;

  constructor(
    transports: NamedTransport[],
    private readonly onDemand?: OnDemandTransports | undefined,
  ) {
    this.transports = [...transports];
  }

  /**
   * Have every transport that can ({@link Transport.consumeRepliesFor}) send this engine instance
   * the results of the tasks it dispatches with `replyTo`. Returns whether any transport does.
   */
  routeReplies(instanceId: string): boolean {
    this.replyInstance = instanceId;
    for (const { id, transport } of this.transports) {
      if (transport.consumeRepliesFor?.(instanceId)) this.replying.add(id);
    }
    return this.replying.size > 0;
  }

  /** Whether `id` is a member (`default` is the primary, the id a single-transport engine stamps). */
  has(id: string): boolean {
    return this.transports.some((t) => t.id === id) || (id === 'default' && this.size > 0);
  }

  /** The ids built on demand so far, in build order. */
  get onDemandBuilt(): readonly string[] {
    return this.builtOnDemand;
  }

  /** Whether `id` is one of the on-demand ids: a step pinned to it records it on its checkpoint. */
  isOnDemand(id: string | undefined): id is string {
    return id !== undefined && (this.onDemand?.ids.includes(id) ?? false);
  }

  /** The on-demand ids not built yet. */
  get onDemandUnbuilt(): string[] {
    return (this.onDemand?.ids ?? []).filter((id) => !this.has(id));
  }

  /**
   * Make sure transport `id` is a member, building it when it is one of the on-demand ids. Concurrent
   * calls share one build; a failed build rejects every caller waiting on it and is forgotten, so a
   * later call builds again. A no-op for a member, or an id that cannot be built (a dispatch pinned
   * to it then fails naming the transports there are).
   */
  async ensure(id: string): Promise<void> {
    if (this.has(id)) return;
    const onDemand = this.onDemand;
    if (!onDemand?.ids.includes(id)) return;
    let build = this.building.get(id);
    if (!build) {
      build = onDemand.build(id).then((transport) => {
        // A build that raced another member with this id (cannot happen through `ensure`) keeps one.
        if (!this.has(id)) this.add({ id, transport });
      });
      this.building.set(id, build);
      const forget = (): void => {
        this.building.delete(id);
      };
      build.then(forget, forget);
    }
    await build;
  }

  /** Append `member`, applying what the pool applied to the others, in the same order. */
  private add(member: NamedTransport): void {
    const { id, transport } = member;
    if (this.namespace !== undefined) transport.useNamespace?.(this.namespace);
    if (this.handlers) this.bindOne(transport, ...this.handlers);
    if (this.replyInstance !== undefined && transport.consumeRepliesFor?.(this.replyInstance)) {
      this.replying.add(id);
    }
    this.transports.push(member);
    this.builtOnDemand.push(id);
    if (this.consumersStarted) transport.startConsumers?.();
  }

  /** `task` as sent on transport `id`: a reply goes back only on a transport that routes it, so
   *  elsewhere `replyTo` is dropped (its result rides the shared results). */
  private withReply<T extends { replyTo?: string | undefined }>(task: T, id: string): T {
    if (task.replyTo === undefined || this.replying.has(id)) return task;
    const { replyTo: _replyTo, ...rest } = task;
    return rest as T;
  }

  get size(): number {
    return this.transports.length;
  }

  /** The pool's transports, in order (read-only: the console reads how each seals its messages). */
  get members(): readonly NamedTransport[] {
    return this.transports;
  }

  /** Register the engine's result/heartbeat/step-event handlers on EVERY transport — a result can come
   *  back on whichever one delivered the task, so failover stays symmetric. `onStepEvent` is wired only
   *  on transports that carry streamed workflow step lifecycle (BullMQ); others simply skip it. */
  bind(
    onResult: ResultHandler,
    onHeartbeat: HeartbeatHandler,
    onStepEvent?: StepEventHandler,
  ): void {
    this.handlers = [onResult, onHeartbeat, onStepEvent];
    for (const { transport } of this.transports) {
      this.bindOne(transport, onResult, onHeartbeat, onStepEvent);
    }
  }

  private bindOne(
    transport: Transport,
    onResult: ResultHandler,
    onHeartbeat: HeartbeatHandler,
    onStepEvent: StepEventHandler | undefined,
  ): void {
    transport.onResult(onResult);
    transport.onHeartbeat(onHeartbeat);
    if (onStepEvent && transport.onStepEvent) {
      transport.onStepEvent(onStepEvent);
    }
  }

  /**
   * Dispatch `task` over the pool: try the preferred (or first) transport, fail over to the next on
   * a dispatch error, and stamp the task with the id of the transport that accepted it (so a worker
   * replies on the matching one). Throws if every transport fails.
   */
  async dispatch(task: Omit<RemoteTask, 'transport'>, preferId?: string): Promise<void> {
    if (preferId) await this.ensure(preferId);
    let lastErr: unknown;
    for (const { id, transport } of this.ordered(preferId)) {
      try {
        await transport.dispatch({ ...this.withReply(task, id), transport: id });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('no transport accepted the dispatch');
  }

  /**
   * {@link dispatch} for many tasks: one {@link Transport.dispatchMany} call on the preferred (or
   * first) transport when it has one, else (or when that call rejects) each task through
   * {@link dispatch}, {@link DISPATCH_CHUNK} at a time, failing over per task.
   */
  async dispatchMany(tasks: Omit<RemoteTask, 'transport'>[], preferId?: string): Promise<void> {
    if (tasks.length === 0) return;
    if (preferId) await this.ensure(preferId);
    const first = this.ordered(preferId)[0];
    if (first?.transport.dispatchMany) {
      try {
        await first.transport.dispatchMany(
          tasks.map((task) => ({ ...this.withReply(task, first.id), transport: first.id })),
        );
        return;
      } catch (err) {
        if (!this.warnedBulkRefusal) {
          this.warnedBulkRefusal = true;
          console.warn(
            `[adonis-durable] transport '${first.id}' refused a bulk dispatch; sending the tasks one by one (reported once): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    for (let at = 0; at < tasks.length; at += DISPATCH_CHUNK) {
      await Promise.all(
        tasks.slice(at, at + DISPATCH_CHUNK).map((task) => this.dispatch(task, preferId)),
      );
    }
  }

  /** Worker-health for `group`, merged across every transport that can report it (a group's queue
   *  and its workers may live on any pinned transport). Undefined when no transport implements
   *  `groupHealth` (e.g. a pure in-process transport — nothing to introspect). */
  async groupHealth(group: string): Promise<GroupHealth | undefined> {
    // Every transport at once (in pool order, so the merged `liveWorkers` order is unchanged).
    const reports = await Promise.all(
      this.transports.flatMap(({ transport }) =>
        transport.groupHealth ? [transport.groupHealth(group)] : [],
      ),
    );
    if (reports.length === 0) return undefined;
    return {
      group,
      depth: reports.reduce((sum, r) => sum + r.depth, 0),
      liveWorkers: reports.flatMap((r) => r.liveWorkers),
    };
  }

  /** Distinct worker groups with a live heartbeat, merged across every transport that can report it. */
  async listWorkerGroups(): Promise<string[]> {
    const lists = await Promise.all(
      this.transports.flatMap(({ transport }) =>
        transport.listWorkerGroups ? [transport.listWorkerGroups()] : [],
      ),
    );
    return [...new Set(lists.flat())];
  }

  /** Whether any transport here can read the fleet's descriptor and heartbeat keyspaces. */
  get introspectsFleet(): boolean {
    return this.transports.some(
      ({ transport }) => transport.readAllWorkerDescriptors || transport.readAllWorkerHeartbeats,
    );
  }

  /** Every live worker descriptor, across every transport that can read them. */
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    const out: WorkerDescriptor[] = [];
    for (const { transport } of this.transports) {
      if (transport.readAllWorkerDescriptors)
        out.push(...(await transport.readAllWorkerDescriptors()));
    }
    return out;
  }

  /** Every live worker heartbeat, across every transport that can read them. */
  async readAllWorkerHeartbeats(): Promise<WorkerHeartbeat[]> {
    const out: WorkerHeartbeat[] = [];
    for (const { transport } of this.transports) {
      if (transport.readAllWorkerHeartbeats)
        out.push(...(await transport.readAllWorkerHeartbeats()));
    }
    return out;
  }

  /**
   * The first transport (in pool order) reporting a LIVE worker for `group` — the one a
   * convention-routed remote workflow must dispatch on. In a mixed pool each transport scans a
   * different keyspace, so dispatching on the first transport while the worker heartbeats on another
   * parks the task on a queue nobody consumes. `undefined` when no transport reports the group.
   */
  async transportWithLiveGroup(group: string): Promise<Transport | undefined> {
    for (const { transport } of this.transports) {
      if (!transport.listWorkerGroups) continue;
      if ((await transport.listWorkerGroups()).includes(group)) return transport;
    }
    return undefined;
  }

  /**
   * Propagate the engine's `namespace` to every transport that partitions by it — so the same
   * namespace that scopes the store also scopes each transport's queues/keys. A transport that
   * doesn't partition (no `useNamespace`) is skipped. Idempotent; a transport given an explicit
   * namespace at construction ignores this (see {@link Transport.useNamespace}).
   */
  useNamespace(namespace: string): void {
    this.namespace = namespace;
    for (const { transport } of this.transports) {
      transport.useNamespace?.(namespace);
    }
  }

  /** Flush deferred consumer subscriptions on every transport that deferred them (see
   *  {@link Transport.startConsumers}); a transport that never defers is skipped. */
  startConsumers(): void {
    this.consumersStarted = true;
    for (const { transport } of this.transports) {
      transport.startConsumers?.();
    }
  }

  /** Pinned `preferId` first, then the rest (failover order). */
  private ordered(preferId?: string): NamedTransport[] {
    if (!preferId) return this.transports;
    let pref = this.transports.filter((t) => t.id === preferId);
    // `default` is the id a single-transport engine stamped on its tasks: a task persisted under it
    // (re-dispatched after an upgrade that named the pool) still means the primary transport.
    if (pref.length === 0 && preferId === 'default' && this.transports[0]) {
      pref = [this.transports[0]];
    }
    if (pref.length === 0) {
      const quoted = (ids: readonly string[]): string =>
        ids.map((id) => `"${id}"`).join(', ') || 'none';
      const registered = quoted(this.transports.map((t) => t.id));
      throw new Error(
        this.onDemand
          ? `transport "${preferId}" is not registered on this engine (registered: ${registered}; ` +
              `${this.onDemand.describe ?? 'built on demand'}: ${quoted(this.onDemand.ids)}). ` +
              `${this.onDemand.hint ?? ''}`.trimEnd()
          : `transport "${preferId}" is not registered on this engine (registered: ${registered}). ` +
              `To pin steps to it, pass it in the WorkflowEngine \`transports\` option ` +
              `(or define it in \`transports\` in config/durable.ts).`,
      );
    }
    return [...pref, ...this.transports.filter((t) => !pref.includes(t))];
  }
}

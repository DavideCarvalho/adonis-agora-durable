import type { WorkerDescriptor } from './handshake/descriptor.js';
import type {
  GroupHealth,
  Heartbeat,
  NamedTransport,
  RemoteTask,
  StepResult,
  Transport,
  WorkerHeartbeat,
  WorkflowStepEvent,
} from './interfaces.js';

/**
 * An ordered pool of named transports. The engine dispatches on the first and fails over to the
 * next on a dispatch error; a step can pin one by id. Pure transport plumbing — no run lifecycle —
 * so it lives apart from the engine.
 */
export class TransportPool {
  constructor(private readonly transports: NamedTransport[]) {}

  get size(): number {
    return this.transports.length;
  }

  /** Register the engine's result/heartbeat/step-event handlers on EVERY transport — a result can come
   *  back on whichever one delivered the task, so failover stays symmetric. `onStepEvent` is wired only
   *  on transports that carry streamed workflow step lifecycle (BullMQ); others simply skip it. */
  bind(
    onResult: (result: StepResult) => Promise<void>,
    onHeartbeat: (beat: Heartbeat) => Promise<void>,
    onStepEvent?: (event: WorkflowStepEvent) => Promise<void>,
  ): void {
    for (const { transport } of this.transports) {
      transport.onResult(onResult);
      transport.onHeartbeat(onHeartbeat);
      if (onStepEvent && transport.onStepEvent) {
        transport.onStepEvent(onStepEvent);
      }
    }
  }

  /**
   * Dispatch `task` over the pool: try the preferred (or first) transport, fail over to the next on
   * a dispatch error, and stamp the task with the id of the transport that accepted it (so a worker
   * replies on the matching one). Throws if every transport fails.
   */
  async dispatch(task: Omit<RemoteTask, 'transport'>, preferId?: string): Promise<void> {
    let lastErr: unknown;
    for (const { id, transport } of this.ordered(preferId)) {
      try {
        await transport.dispatch({ ...task, transport: id });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('no transport accepted the dispatch');
  }

  /** Worker-health for `group`, merged across every transport that can report it (a group's queue
   *  and its workers may live on any pinned transport). Undefined when no transport implements
   *  `groupHealth` (e.g. a pure in-process transport — nothing to introspect). */
  async groupHealth(group: string): Promise<GroupHealth | undefined> {
    const reports: GroupHealth[] = [];
    for (const { transport } of this.transports) {
      if (transport.groupHealth) reports.push(await transport.groupHealth(group));
    }
    if (reports.length === 0) return undefined;
    return {
      group,
      depth: reports.reduce((sum, r) => sum + r.depth, 0),
      liveWorkers: reports.flatMap((r) => r.liveWorkers),
    };
  }

  /** Distinct worker groups with a live heartbeat, merged across every transport that can report it. */
  async listWorkerGroups(): Promise<string[]> {
    const groups = new Set<string>();
    for (const { transport } of this.transports) {
      if (transport.listWorkerGroups) {
        for (const g of await transport.listWorkerGroups()) groups.add(g);
      }
    }
    return [...groups];
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
    for (const { transport } of this.transports) {
      transport.useNamespace?.(namespace);
    }
  }

  /** Flush deferred consumer subscriptions on every transport that deferred them (see
   *  {@link Transport.startConsumers}); a transport that never defers is skipped. */
  startConsumers(): void {
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
      const ids = this.transports.map((t) => `"${t.id}"`).join(', ') || 'none';
      throw new Error(
        `transport "${preferId}" is not registered on this engine (registered: ${ids}). ` +
          `To pin steps to it, build it into the pool: list it in \`transportPool\` in ` +
          `config/durable.ts (or pass it in the WorkflowEngine \`transports\` option).`,
      );
    }
    return [...pref, ...this.transports.filter((t) => !pref.includes(t))];
  }
}

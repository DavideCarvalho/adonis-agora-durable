import type {
  AttributeFilter,
  CheckpointQuery,
  CheckpointStat,
  ChildWait,
  RunFacetQuery,
  RunFacetRow,
  RunQuery,
  RunStatus,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  ScheduleQuery,
  ScheduleRecord,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  WorkflowRun,
} from '../interfaces.js';
import { namespaceMatches, normalizeNamespace } from '../namespaces.js';
import { checkpointStatsOf, queryCheckpointsOf } from '../run-detail-summary.js';
import { mergeRunFacetRows } from '../run-facets.js';
import { runPageWindow } from '../run-pagination.js';
import { scanRunValueFacets } from '../run-value-facets.js';
import { normalizeAttributeRows, type RunAttributeRow } from '../search-attributes.js';
import {
  settlesTerminally,
  singletonAdmissionDenialPatch,
  singletonAdmissionTags,
  withoutAdmission,
} from '../singleton-admission.js';

/**
 * A non-durable, in-process `StateStore` for tests and local development.
 * The shipped `@dudousxd/nestjs-durable-store` package re-exports an equivalent.
 */
/**
 * Everything an {@link InMemoryStateStore} holds, in ONE object, so a {@link InMemoryStateStore.withScope}
 * view can share it by reference: a write through either is visible through both, and the read
 * counters are one set. Only the scope is per view.
 */
interface InMemoryState {
  readonly runs: Map<string, WorkflowRun>;
  readonly checkpoints: Map<string, StepCheckpoint>;
  readonly signalWaiters: Map<string, SignalWaiter>;
  readonly attributeIndex: Map<string, Map<string, RunAttributeRow>>;
  readonly bufferedSignals: Map<string, unknown[]>;
  readonly bufferedEvents: Map<string, { name: string; payload: unknown; publishedAt: number }>;
  readonly schedules: Map<string, ScheduleRecord>;
  readonly stats: {
    lastAttributeCandidates: number;
    lastCheckpointRowsRead: number;
    checkpointRowsRead: number;
  };
}

/** A caller's copy of a stored run, with a legacy `''`/absent namespace read as `'default'`. */
const copyRun = (run: WorkflowRun): WorkflowRun => ({
  ...run,
  namespace: normalizeNamespace(run.namespace),
});

/** A run about to be stored, its namespace normalized (`''` is the default pool). */
const withNormalizedNamespace = (run: WorkflowRun): WorkflowRun =>
  run.namespace === undefined || run.namespace === '' ? copyRun(run) : run;

const freshState = (): InMemoryState => ({
  runs: new Map(),
  checkpoints: new Map(),
  signalWaiters: new Map(),
  attributeIndex: new Map(),
  bufferedSignals: new Map(),
  bufferedEvents: new Map(),
  schedules: new Map(),
  stats: { lastAttributeCandidates: 0, lastCheckpointRowsRead: 0, checkpointRowsRead: 0 },
});

export class InMemoryStateStore implements StateStore {
  /** All of this store's data; shared by reference with every {@link withScope} view. */
  private state: InMemoryState = freshState();
  private get runs(): Map<string, WorkflowRun> {
    return this.state.runs;
  }
  private get checkpoints(): Map<string, StepCheckpoint> {
    return this.state.checkpoints;
  }
  private get signalWaiters(): Map<string, SignalWaiter> {
    return this.state.signalWaiters;
  }

  /**
   * Normalized search-attribute side-table, the in-memory analog of the SQL stores'
   * `durable_run_attributes`: `key -> (runId -> row)`. Maintained on every create/update so an
   * attribute query can be pushed DOWN to a key-indexed candidate set instead of scanning every run
   * and comparing in-process. Mirrors {@link normalizeAttributeRows} so behavior matches the SQL path.
   */
  private get attributeIndex(): Map<string, Map<string, RunAttributeRow>> {
    return this.state.attributeIndex;
  }
  /** Test/observability hook: how many candidate runs the last attribute query's index produced. */
  get lastAttributeCandidates(): number {
    return this.state.stats.lastAttributeCandidates;
  }
  set lastAttributeCandidates(value: number) {
    this.state.stats.lastAttributeCandidates = value;
  }
  /**
   * Test/observability hook: how many checkpoint rows the LAST checkpoint read materialized (the rows
   * actually returned to the caller). `listCheckpoints` returns all rows for the run; the targeted
   * {@link getLatestCheckpointByName} / {@link listCheckpointsByNamePrefix} return only the matches —
   * so this lets the benchmark contrast "fetch N, scan in JS" against "fetch the k that match".
   */
  get lastCheckpointRowsRead(): number {
    return this.state.stats.lastCheckpointRowsRead;
  }
  set lastCheckpointRowsRead(value: number) {
    this.state.stats.lastCheckpointRowsRead = value;
  }
  /**
   * Test/observability hook: checkpoint rows materialized since construction, across every
   * checkpoint read that returns rows — what a run-detail test compares between paths.
   */
  get checkpointRowsRead(): number {
    return this.state.stats.checkpointRowsRead;
  }
  set checkpointRowsRead(value: number) {
    this.state.stats.checkpointRowsRead = value;
  }
  /** The namespace run reads are fenced to (see {@link withScope}); undefined sees every run. */
  private scopeNamespace: string | undefined;

  /**
   * A view of THIS store (same data) whose run reads — `getRun`, `listRuns`, the counts and the
   * recovery/dispatch/timer scans — only see `scope.namespace`. Writes stay unscoped. Mirrors
   * `LucidStateStore.withScope`; `{ namespace: undefined }` is the operator view.
   */
  withScope(scope: { namespace?: string | undefined }): InMemoryStateStore {
    // A plain store holding the SAME state object by reference (not an `Object.create(this)` child,
    // whose own-property writes — a counter bump — would shadow the base's, and which would break on
    // any `#private` field). Overrides of a subclass are not carried over to the view.
    const view = new InMemoryStateStore();
    view.state = this.state;
    view.scopeNamespace = scope.namespace;
    return view;
  }

  private inScope(run: WorkflowRun): boolean {
    return (
      this.scopeNamespace === undefined || namespaceMatches(run.namespace, this.scopeNamespace)
    );
  }

  private visibleRuns(): WorkflowRun[] {
    const runs = [...this.runs.values()];
    return this.scopeNamespace === undefined ? runs : runs.filter((r) => this.inScope(r));
  }

  private key(runId: string, seq: number): string {
    return `${runId}:${seq}`;
  }

  /** Drop then re-add a run's normalized attribute rows so the index tracks its current attributes. */
  private reindexAttributes(runId: string, attributes: WorkflowRun['searchAttributes']): void {
    for (const byRun of this.attributeIndex.values()) byRun.delete(runId);
    for (const row of normalizeAttributeRows(runId, attributes)) {
      let byRun = this.attributeIndex.get(row.key);
      if (!byRun) {
        byRun = new Map();
        this.attributeIndex.set(row.key, byRun);
      }
      byRun.set(runId, row);
    }
  }

  async createRun(run: WorkflowRun): Promise<void> {
    // Duplicate ids throw, mirroring the SQL stores' primary-key violation — the engine relies on
    // that to make racing `start`s converge on one run instead of silently overwriting the winner.
    if (this.runs.has(run.id)) {
      throw new Error(`run ${run.id} already exists`);
    }
    // Normalize an undefined namespace to 'default', matching the SQL stores' column DEFAULT 'default'
    // — so a run created directly against this store (bypassing the engine, e.g. in tests) is still
    // reachable via a namespace='default' filter and partitions consistently.
    this.runs.set(run.id, { ...run, namespace: normalizeNamespace(run.namespace) });
    this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`run ${runId} not found`);
    const next = withNormalizedNamespace({
      ...existing,
      ...patch,
      ...releasedSlot(existing, patch),
    });
    this.runs.set(runId, next);
    if ('searchAttributes' in patch) this.reindexAttributes(runId, next.searchAttributes);
  }

  async updateRunIf(
    runId: string,
    expectedStatuses: RunStatus[],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    // No `await` between the check and the mutation — atomic within this single-threaded store, the
    // same reasoning tryLockRun/renewRunLock already rely on for their compare-and-set.
    const existing = this.runs.get(runId);
    if (!existing || !expectedStatuses.includes(existing.status)) return false;
    const next = withNormalizedNamespace({
      ...existing,
      ...patch,
      ...releasedSlot(existing, patch),
    });
    this.runs.set(runId, next);
    if ('searchAttributes' in patch) this.reindexAttributes(runId, next.searchAttributes);
    return true;
  }

  async tryAdmitSingleton(
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ): Promise<boolean> {
    // No `await` between the snapshot and the claim: this synchronous turn is the critical section.
    const runs = [...this.runs.values()];
    const tags = singletonAdmissionTags(runs, runId, tag, workflow, limit);
    const run = this.runs.get(runId);
    if (!tags || !run) {
      const parked = singletonAdmissionDenialPatch(runs, runId, tag, workflow, retryWakeAt);
      if (parked && run) this.runs.set(runId, { ...run, ...parked });
      return false;
    }
    this.runs.set(runId, { ...run, tags });
    return true;
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(runId);
    return run && this.inScope(run) ? copyRun(run) : null;
  }

  async deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    for (const [key, cp] of this.checkpoints) {
      if (cp.runId === runId) this.checkpoints.delete(key);
    }
    for (const [token, waiter] of this.signalWaiters) {
      if (waiter.runId === runId) this.signalWaiters.delete(token);
    }
    // Drop the run's normalized attribute rows (reindex with no attributes clears them).
    this.reindexAttributes(runId, undefined);
  }

  async deleteRuns(runIds: string[]): Promise<void> {
    for (const runId of runIds) await this.deleteRun(runId);
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const cp = this.checkpoints.get(this.key(runId, seq));
    return cp ? { ...cp } : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    this.checkpoints.set(this.key(checkpoint.runId, checkpoint.seq), { ...checkpoint });
  }

  async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
    const key = this.key(checkpoint.runId, checkpoint.seq);
    if (this.checkpoints.get(key)?.status !== 'pending') return false;
    this.checkpoints.set(key, { ...checkpoint });
    return true;
  }

  async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
    return checkpoints.map((checkpoint) => {
      const key = this.key(checkpoint.runId, checkpoint.seq);
      if (this.checkpoints.get(key)?.status !== 'pending') return false;
      this.checkpoints.set(key, { ...checkpoint });
      return true;
    });
  }

  /** Mirror of `LucidStateStore.recordStepHeartbeat`: mutate in place, no-op when absent. */
  async recordStepHeartbeat(
    runId: string,
    seq: number,
    at: Date,
    progress?: unknown,
  ): Promise<void> {
    const cp = this.checkpoints.get(this.key(runId, seq));
    if (!cp) return;
    cp.lastHeartbeatAt = at;
    cp.heartbeatProgress = progress;
  }

  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    return this.visibleRuns()
      .filter(
        (r) =>
          r.status === 'running' &&
          (namespace === undefined || namespaceMatches(r.namespace, namespace)),
      )
      .map(copyRun);
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    return this.visibleRuns()
      .filter(
        (r) =>
          r.status === 'pending' &&
          (namespace === undefined || namespaceMatches(r.namespace, namespace)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(copyRun);
  }

  async listDueTimers(nowMs: number, namespace?: string, limit?: number): Promise<WorkflowRun[]> {
    const due = this.visibleRuns().filter(
      (r) =>
        r.status === 'suspended' &&
        r.wakeAt !== undefined &&
        r.wakeAt <= nowMs &&
        (namespace === undefined || namespaceMatches(r.namespace, namespace)),
    );
    // Most overdue first (mirrors the SQL stores' ORDER BY wake_at).
    due.sort((a, b) => (a.wakeAt ?? 0) - (b.wakeAt ?? 0));
    return (limit === undefined ? due : due.slice(0, limit)).map(copyRun);
  }

  async listOrphanedRuns(nowMs: number, limit: number, namespace?: string): Promise<WorkflowRun[]> {
    return this.visibleRuns()
      .filter(
        (r) =>
          r.status === 'running' &&
          (r.lockedUntil === undefined || r.lockedUntil <= nowMs) &&
          (namespace === undefined || namespaceMatches(r.namespace, namespace)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map(copyRun);
  }

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.lockedUntil !== undefined && run.lockedUntil > nowMs) return false;
    run.lockedBy = owner;
    run.lockedUntil = leaseUntilMs;
    return true;
  }

  async releaseRunLock(runId: string, owner?: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    // Owner-scoped release: a stale executor whose lease was taken over must not wipe the new
    // owner's lease (same single-threaded atomicity reasoning as renewRunLock).
    if (owner !== undefined && run.lockedBy !== owner) return;
    run.lockedBy = undefined;
    run.lockedUntil = undefined;
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.lockedBy !== owner) return false;
    run.lockedUntil = leaseUntilMs;
    return true;
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    this.signalWaiters.set(waiter.token, { ...waiter });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const waiter = this.signalWaiters.get(token);
    if (!waiter) return null;
    this.signalWaiters.delete(token);
    return { ...waiter };
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    return [...this.signalWaiters.values()]
      .filter((w) => w.token.startsWith(prefix))
      .map((w) => ({ ...w }));
  }

  async listSignalWaitersByRunIds(runIds: string[]): Promise<SignalWaiter[]> {
    if (runIds.length === 0) return [];
    const ids = new Set(runIds);
    return [...this.signalWaiters.values()].filter((w) => ids.has(w.runId)).map((w) => ({ ...w }));
  }

  async hasSignalWaiter(runId: string, tokenPrefix: string): Promise<boolean> {
    for (const w of this.signalWaiters.values()) {
      if (w.runId === runId && w.token.startsWith(tokenPrefix)) return true;
    }
    return false;
  }

  async registerChildWaits(entries: ChildWait[]): Promise<void> {
    for (const { waiter } of entries) this.signalWaiters.set(waiter.token, { ...waiter });
    for (const { checkpoint } of entries) await this.saveCheckpoint(checkpoint);
  }

  async compactCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    into: StepCheckpoint,
  ): Promise<void> {
    for (let seq = fromSeq; seq <= toSeq; seq += 1) this.checkpoints.delete(this.key(runId, seq));
    this.checkpoints.set(this.key(runId, into.seq), { ...into, runId });
  }

  async removeSignalWaiter(waiter: SignalWaiter): Promise<void> {
    // Keyed by token only (one row per token) — only delete if the CURRENT row still matches this
    // exact (runId, seq); a later putSignalWaiter for the same token may have already replaced it
    // with a different run's row, which must be left alone.
    const current = this.signalWaiters.get(waiter.token);
    if (current && current.runId === waiter.runId && current.seq === waiter.seq) {
      this.signalWaiters.delete(waiter.token);
    }
  }

  // No real DB transaction (there's no DB) — run the work and save the checkpoint. Exactly-once
  // across a crash needs a SQL store; this keeps `ctx.transaction` usable in tests / local dev.
  async transaction<T>(
    work: (tx: {
      raw: unknown;
      saveCheckpoint: (cp: StepCheckpoint) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return work({ raw: this, saveCheckpoint: (cp) => this.saveCheckpoint(cp) });
  }

  private get bufferedSignals(): Map<string, unknown[]> {
    return this.state.bufferedSignals;
  }
  async bufferSignal(token: string, payload: unknown): Promise<void> {
    const queue = this.bufferedSignals.get(token) ?? [];
    queue.push(payload);
    this.bufferedSignals.set(token, queue);
  }
  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const queue = this.bufferedSignals.get(token);
    if (!queue || queue.length === 0) return null;
    const payload = queue.shift();
    if (queue.length === 0) this.bufferedSignals.delete(token);
    return { payload };
  }

  /** `id -> row`, so {@link removeBufferedEvent} can delete an exact row regardless of iteration
   *  order — mirrors the SQL store's PK-by-id delete. */
  private get bufferedEvents(): InMemoryState['bufferedEvents'] {
    return this.state.bufferedEvents;
  }
  async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    this.bufferedEvents.set(input.id, {
      name: input.name,
      payload: input.payload,
      publishedAt: input.publishedAt,
    });
  }
  async listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>> {
    return [...this.bufferedEvents.entries()]
      .filter(([, e]) => e.name === name)
      .sort((a, b) => a[1].publishedAt - b[1].publishedAt) // oldest first
      .slice(0, limit)
      .map(([id, e]) => ({ id, payload: e.payload, publishedAt: e.publishedAt }));
  }
  async removeBufferedEvent(id: string): Promise<boolean> {
    return this.bufferedEvents.delete(id);
  }
  async pruneBufferedEvents(publishedBefore: number, limit: number): Promise<number> {
    const expired = [...this.bufferedEvents.entries()]
      .filter(([, e]) => e.publishedAt < publishedBefore)
      .sort((a, b) => a[1].publishedAt - b[1].publishedAt)
      .slice(0, Math.max(0, limit));
    for (const [id] of expired) this.bufferedEvents.delete(id);
    return expired.length;
  }

  /**
   * Candidate run ids satisfying ONE attribute predicate, served from {@link attributeIndex} — the
   * pushdown step. Numeric predicates scan only `numValue` rows under the key; string/boolean ones
   * scan `strValue` rows. This is the in-memory analog of the SQL EXISTS on `durable_run_attributes`.
   */
  private candidatesForFilter(f: AttributeFilter): Set<string> {
    const byRun = this.attributeIndex.get(f.key);
    const out = new Set<string>();
    if (!byRun) return out;
    if (f.op === 'in') {
      // A set predicate is an OR over its members: any row whose normalized value equals any member
      // qualifies. An empty set matches nothing (mirrors `RunQuery.statuses`).
      const numeric = f.values.every((v) => typeof v === 'number');
      const operands = new Set(
        f.values.map((v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : v)),
      );
      for (const row of byRun.values()) {
        const actual = numeric ? row.numValue : row.strValue;
        if (actual == null) continue;
        if (operands.has(actual)) out.add(row.runId);
      }
      return out;
    }
    const numeric = typeof f.value === 'number';
    const operand = typeof f.value === 'boolean' ? (f.value ? 'true' : 'false') : f.value;
    for (const row of byRun.values()) {
      const actual = numeric ? row.numValue : row.strValue;
      if (actual == null) continue;
      let ok = false;
      switch (f.op) {
        case 'eq':
          ok = actual === operand;
          break;
        case 'ne':
          ok = actual !== operand;
          break;
        case 'gt':
          ok = actual > operand;
          break;
        case 'gte':
          ok = actual >= operand;
          break;
        case 'lt':
          ok = actual < operand;
          break;
        case 'lte':
          ok = actual <= operand;
          break;
      }
      if (ok) out.add(row.runId);
    }
    return out;
  }

  async countRuns(query: Omit<RunQuery, 'page' | 'size'>): Promise<number> {
    return (await this.listRuns(query)).length;
  }

  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const runs = await this.listRuns(query);
    return mergeRunFacetRows(runs.map((r) => ({ status: r.status, origin: r.origin, count: 1 })));
  }

  private get schedules(): Map<string, ScheduleRecord> {
    return this.state.schedules;
  }

  async saveSchedule(record: ScheduleRecord): Promise<void> {
    this.schedules.set(record.id, {
      ...structuredClone(record),
      namespace: normalizeNamespace(record.namespace),
    });
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const record = this.schedules.get(id);
    return record ? structuredClone(record) : null;
  }

  async updateSchedule(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt'>>,
    expectedNextFireAt?: number | null,
  ): Promise<boolean> {
    const record = this.schedules.get(id);
    if (!record) return false;
    if (expectedNextFireAt !== undefined && record.nextFireAt !== expectedNextFireAt) return false;
    const next = { ...record, ...structuredClone(patch) };
    this.schedules.set(id, { ...next, namespace: normalizeNamespace(next.namespace) });
    return true;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    return this.schedules.delete(id);
  }

  async listSchedules(query: ScheduleQuery): Promise<ScheduleRecord[]> {
    const rows = [...this.schedules.values()]
      .filter(
        (s) => query.namespace === undefined || namespaceMatches(s.namespace, query.namespace),
      )
      .filter((s) => query.workflow === undefined || s.workflow === query.workflow)
      .filter((s) => query.tag === undefined || (s.tags ?? []).includes(query.tag))
      .filter((s) => query.paused === undefined || s.paused === query.paused)
      .filter(
        (s) =>
          query.dueBy === undefined ||
          (!s.paused && s.nextFireAt !== null && s.nextFireAt <= query.dueBy),
      )
      .sort(
        (a, b) =>
          (a.nextFireAt ?? Number.POSITIVE_INFINITY) - (b.nextFireAt ?? Number.POSITIVE_INFINITY) ||
          a.id.localeCompare(b.id),
      );
    const offset = query.offset ?? 0;
    return rows
      .slice(offset, query.limit != null ? offset + query.limit : undefined)
      .map((s) => structuredClone(s));
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    let runs = this.visibleRuns();
    if (query.workflow) runs = runs.filter((r) => r.workflow === query.workflow);
    if (query.workflows) {
      runs =
        query.workflows.length === 0
          ? []
          : runs.filter((r) => query.workflows?.includes(r.workflow));
    }
    if (query.namespace !== undefined) {
      const namespace = query.namespace;
      runs = runs.filter((r) => namespaceMatches(r.namespace, namespace));
    }
    if (query.namespaces) {
      runs =
        query.namespaces.length === 0
          ? []
          : runs.filter(
              (r) => query.namespaces?.some((ns) => namespaceMatches(r.namespace, ns)) ?? false,
            );
    }
    if (query.origin) runs = runs.filter((r) => r.origin === query.origin);
    if (query.status) runs = runs.filter((r) => r.status === query.status);
    if (query.statuses) runs = runs.filter((r) => query.statuses?.includes(r.status));
    if (query.tag) runs = runs.filter((r) => r.tags?.includes(query.tag as string));
    if (query.tags) {
      runs =
        query.tags.length === 0
          ? []
          : runs.filter((r) => r.tags?.some((t) => query.tags?.includes(t)));
    }
    if (query.createdBefore !== undefined) {
      const before = query.createdBefore;
      runs = runs.filter((r) => r.createdAt.getTime() <= before);
    }
    if (query.createdAfter !== undefined) {
      const after = query.createdAfter;
      runs = runs.filter((r) => r.createdAt.getTime() >= after);
    }
    if (query.updatedBefore !== undefined) {
      const before = query.updatedBefore;
      runs = runs.filter((r) => r.updatedAt.getTime() <= before);
    }
    if (query.wakeBefore !== undefined) {
      const wake = query.wakeBefore;
      runs = runs.filter((r) => r.wakeAt !== undefined && r.wakeAt <= wake);
    }
    if (query.attributes?.length) {
      // Pushdown: intersect per-predicate candidate sets from the key-indexed side-table, so we only
      // ever materialize the runs that already satisfy EVERY attribute filter (no full per-run scan).
      let candidates: Set<string> | null = null;
      for (const f of query.attributes) {
        const next = this.candidatesForFilter(f);
        if (candidates == null) {
          candidates = next;
        } else {
          const prev: Set<string> = candidates;
          candidates = new Set([...prev].filter((id) => next.has(id)));
        }
        if (candidates.size === 0) break;
      }
      const ids = candidates ?? new Set<string>();
      this.lastAttributeCandidates = ids.size;
      runs = runs.filter((r) => ids.has(r.id));
    }
    // Newest first (matches the store adapters' `createdAt DESC`) — recent runs on top in the dashboard.
    runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    // 1-based `page`/`size` in, 0-based slice out — same resolution the SQL adapters apply.
    const { limit, offset } = runPageWindow(query);
    return runs.slice(offset, limit === undefined ? undefined : offset + limit).map(copyRun);
  }

  /**
   * The distinct values of ONE filter axis over the runs matching `query`, with counts — what a
   * console's pickers list. Counted in-process over a bounded scan of the newest matching runs (see
   * {@link RUN_VALUE_FACET_SCAN}): this store holds everything in memory, so the scan is the whole
   * answer here rather than an approximation.
   */
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    return scanRunValueFacets(this, axis, query, opts);
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = [...this.checkpoints.values()]
      .filter((cp) => cp.runId === runId)
      .sort((a, b) => a.seq - b.seq)
      .map((cp) => ({ ...cp }));
    this.lastCheckpointRowsRead = rows.length;
    this.checkpointRowsRead += rows.length;
    return rows;
  }

  async checkpointStats(
    runId: string,
    opts?: { group?: string | undefined },
  ): Promise<CheckpointStat[]> {
    return checkpointStatsOf(this.runCheckpoints(runId), opts);
  }

  async queryCheckpoints(runId: string, query: CheckpointQuery): Promise<StepCheckpoint[]> {
    const rows = queryCheckpointsOf(this.runCheckpoints(runId), query).map((cp) => ({ ...cp }));
    this.lastCheckpointRowsRead = rows.length;
    this.checkpointRowsRead += rows.length;
    return rows;
  }

  private runCheckpoints(runId: string): StepCheckpoint[] {
    return [...this.checkpoints.values()].filter((cp) => cp.runId === runId);
  }

  async getLatestCheckpointByName(
    runId: string,
    name: string,
  ): Promise<StepCheckpoint | undefined> {
    let latest: StepCheckpoint | undefined;
    for (const cp of this.checkpoints.values()) {
      if (cp.runId !== runId || cp.name !== name) continue;
      if (!latest || cp.seq > latest.seq) latest = cp;
    }
    this.lastCheckpointRowsRead = latest ? 1 : 0;
    return latest ? { ...latest } : undefined;
  }

  async countCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ): Promise<number> {
    let n = 0;
    for (const cp of this.checkpoints.values()) {
      if (
        cp.runId === runId &&
        cp.seq >= fromSeq &&
        cp.seq <= toSeq &&
        statuses.includes(cp.status)
      )
        n += 1;
    }
    return n;
  }

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    const rows = [...this.checkpoints.values()]
      .filter((cp) => cp.runId === runId && prefixes.some((p) => cp.name.startsWith(p)))
      .sort((a, b) => a.seq - b.seq)
      .map((cp) => ({ ...cp }));
    this.lastCheckpointRowsRead = rows.length;
    this.checkpointRowsRead += rows.length;
    return rows;
  }
}

/** A terminal settle releases the run's singleton slot: drop the admission marker from its tags. */
function releasedSlot(
  existing: WorkflowRun,
  patch: Partial<WorkflowRun>,
): Pick<WorkflowRun, 'tags'> | undefined {
  if (!settlesTerminally(patch)) return undefined;
  const tags = withoutAdmission('tags' in patch ? patch.tags : existing.tags);
  return tags ? { tags } : undefined;
}

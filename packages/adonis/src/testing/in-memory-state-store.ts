import type {
  RunQuery,
  RunStatus,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  WorkflowRun,
} from '../interfaces.js';
import type { AttributeFilter } from '../interfaces.js';
import { type RunAttributeRow, normalizeAttributeRows } from '../search-attributes.js';

/**
 * A non-durable, in-process `StateStore` for tests and local development.
 * The shipped `@dudousxd/nestjs-durable-store` package re-exports an equivalent.
 */
export class InMemoryStateStore implements StateStore {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly checkpoints = new Map<string, StepCheckpoint>();
  private readonly signalWaiters = new Map<string, SignalWaiter>();

  /**
   * Normalized search-attribute side-table, the in-memory analog of the SQL stores'
   * `durable_run_attributes`: `key -> (runId -> row)`. Maintained on every create/update so an
   * attribute query can be pushed DOWN to a key-indexed candidate set instead of scanning every run
   * and comparing in-process. Mirrors {@link normalizeAttributeRows} so behavior matches the SQL path.
   */
  private readonly attributeIndex = new Map<string, Map<string, RunAttributeRow>>();
  /** Test/observability hook: how many candidate runs the last attribute query's index produced. */
  lastAttributeCandidates = 0;
  /**
   * Test/observability hook: how many checkpoint rows the LAST checkpoint read materialized (the rows
   * actually returned to the caller). `listCheckpoints` returns all rows for the run; the targeted
   * {@link getLatestCheckpointByName} / {@link listCheckpointsByNamePrefix} return only the matches —
   * so this lets the benchmark contrast "fetch N, scan in JS" against "fetch the k that match".
   */
  lastCheckpointRowsRead = 0;

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
    // Normalize an undefined namespace to 'default', matching the SQL stores' column DEFAULT 'default'
    // — so a run created directly against this store (bypassing the engine, e.g. in tests) is still
    // reachable via a namespace='default' filter and partitions consistently.
    this.runs.set(run.id, { ...run, namespace: run.namespace ?? 'default' });
    this.reindexAttributes(run.id, run.searchAttributes);
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`run ${runId} not found`);
    const next = { ...existing, ...patch };
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
    const next = { ...existing, ...patch };
    this.runs.set(runId, next);
    if ('searchAttributes' in patch) this.reindexAttributes(runId, next.searchAttributes);
    return true;
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
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

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const cp = this.checkpoints.get(this.key(runId, seq));
    return cp ? { ...cp } : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    this.checkpoints.set(this.key(checkpoint.runId, checkpoint.seq), { ...checkpoint });
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
    return [...this.runs.values()]
      .filter(
        (r) => r.status === 'running' && (namespace === undefined || r.namespace === namespace),
      )
      .map((r) => ({ ...r }));
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter(
        (r) => r.status === 'pending' && (namespace === undefined || r.namespace === namespace),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.status === 'suspended' &&
          r.wakeAt !== undefined &&
          r.wakeAt <= nowMs &&
          (namespace === undefined || r.namespace === namespace),
      )
      .map((r) => ({ ...r }));
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

  async releaseRunLock(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (run) {
      run.lockedBy = undefined;
      run.lockedUntil = undefined;
    }
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

  private readonly bufferedSignals = new Map<string, unknown[]>();
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
  private readonly bufferedEvents = new Map<
    string,
    { name: string; payload: unknown; publishedAt: number }
  >();
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

  /**
   * Candidate run ids satisfying ONE attribute predicate, served from {@link attributeIndex} — the
   * pushdown step. Numeric predicates scan only `numValue` rows under the key; string/boolean ones
   * scan `strValue` rows. This is the in-memory analog of the SQL EXISTS on `durable_run_attributes`.
   */
  private candidatesForFilter(f: AttributeFilter): Set<string> {
    const byRun = this.attributeIndex.get(f.key);
    const out = new Set<string>();
    if (!byRun) return out;
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

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    let runs = [...this.runs.values()];
    if (query.workflow) runs = runs.filter((r) => r.workflow === query.workflow);
    if (query.namespace !== undefined) runs = runs.filter((r) => r.namespace === query.namespace);
    if (query.status) runs = runs.filter((r) => r.status === query.status);
    if (query.statuses) runs = runs.filter((r) => query.statuses?.includes(r.status));
    if (query.tag) runs = runs.filter((r) => r.tags?.includes(query.tag as string));
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
    const offset = query.offset ?? 0;
    const limit = query.limit ?? runs.length;
    return runs.slice(offset, offset + limit).map((r) => ({ ...r }));
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = [...this.checkpoints.values()]
      .filter((cp) => cp.runId === runId)
      .sort((a, b) => a.seq - b.seq)
      .map((cp) => ({ ...cp }));
    this.lastCheckpointRowsRead = rows.length;
    return rows;
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

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    const rows = [...this.checkpoints.values()]
      .filter((cp) => cp.runId === runId && prefixes.some((p) => cp.name.startsWith(p)))
      .sort((a, b) => a.seq - b.seq)
      .map((cp) => ({ ...cp }));
    this.lastCheckpointRowsRead = rows.length;
    return rows;
  }
}

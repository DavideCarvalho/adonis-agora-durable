import type { Database } from '@adonisjs/lucid/database';
import type {
  QueryClientContract,
  TransactionClientContract,
} from '@adonisjs/lucid/types/database';
import type {
  AttributeFilter,
  BufferedSignalRow,
  CheckpointNameKind,
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
  StepSettlement,
  WorkflowRun,
} from '../interfaces.js';
import { namespaceFilterValues, normalizeNamespace } from '../namespaces.js';
import { mergeRunFacetRows } from '../run-facets.js';
import { runPageWindow } from '../run-pagination.js';
import {
  axisIsRunColumn,
  mergeRunValueFacetRows,
  RUN_VALUE_FACET_LIMIT,
  RUN_VALUE_FACET_SCAN,
  runValueFacetsFromRuns,
} from '../run-value-facets.js';
import {
  attributeColumnFor,
  attributeOperand,
  attributeOperands,
  normalizeAttributeRows,
  sqlComparator,
} from '../search-attributes.js';
import {
  SINGLETON_ACTIVE_STATUSES,
  SINGLETON_ADMITTED_TAG,
  settlesTerminally,
  singletonAdmissionDenialPatch,
  singletonAdmissionTags,
  withoutAdmission,
} from '../singleton-admission.js';
import {
  CHECKPOINT_COLUMNS_BUT_INPUT,
  type CheckpointRow,
  checkpointToRow,
  parseJsonColumn,
  type RunRow,
  rowToCheckpoint,
  rowToRun,
  rowToSignalWaiter,
  runPatchToRow,
  runToRow,
  SETTLED_CHECKPOINT_COLUMNS,
  settlementToRow,
} from './lucid-mappers.js';
import { createDurableTables, DURABLE_TABLES } from './lucid-schema.js';

/** A Lucid query client — either the connection client or a transaction client. */
type Client = QueryClientContract | TransactionClientContract;

/**
 * Lucid's chainable query-builder type isn't exported precisely enough to type a sub-query callback,
 * so the EXISTS-subquery builder uses this single escape hatch. Confined to {@link
 * LucidStateStore.applyAttributeExists}.
 */
// biome-ignore lint/suspicious/noExplicitAny: Lucid's query-builder type isn't exported precisely.
type AnyQuery = any;

export interface LucidStateStoreOptions {
  /**
   * The Lucid connection name to use. Defaults to the connection's primary (the `Database` default).
   * Pass this if the durable tables live on a dedicated connection.
   */
  connectionName?: string;
  /**
   * Confine the store's RUN reads to one namespace (`getRun`, `listRuns`, `countRuns`, the facet
   * queries and the recovery/dispatch/timer scans): a tenant-boundary view. Writes stay unscoped.
   * Omit (or `{ namespace: undefined }`) for the operator view that sees every namespace. The
   * `scopeReads` config option builds this from `namespace` via {@link LucidStateStore.withScope}.
   */
  scope?: { namespace?: string | undefined } | undefined;
  /**
   * MySQL/MariaDB: the collation `ensureSchema` creates and aligns the durable tables to (see
   * `CreateDurableTablesOptions.collation`). Ignored on other dialects.
   */
  collation?: string | undefined;
}

/**
 * A production-grade, persistent `StateStore` backed by AdonisJS **Lucid** (Knex). Runs, checkpoints,
 * timers, signal waiters, run attributes and recovery leases live in SQL, so durable state survives
 * restarts and works across processes — the behavioral twin of core's `InMemoryStateStore`.
 *
 * Portable across SQLite / Postgres / MySQL: JSON payloads are stored as TEXT (serialized here) and
 * all timestamps are epoch-ms integers, so there's no dependency on a dialect's native JSON/date type.
 *
 * Usually you don't construct this directly: `config/durable.ts` selects it via
 * `stores.lucid({ ... })` and the provider builds it for you.
 */
export class LucidStateStore implements StateStore {
  private readonly db: Database;
  private readonly connectionName: string | undefined;
  private readonly options: LucidStateStoreOptions;
  /** The namespace run reads are fenced to, or undefined for the operator view. */
  private readonly scopeNamespace: string | undefined;

  constructor(db: Database, options: LucidStateStoreOptions = {}) {
    this.db = db;
    this.connectionName = options.connectionName;
    this.options = options;
    this.scopeNamespace = options.scope?.namespace;
  }

  /**
   * A store over the same `Database` whose run reads are confined to `scope.namespace` (see
   * {@link LucidStateStoreOptions.scope}). `{ namespace: undefined }` is the unscoped operator view.
   */
  withScope(scope: { namespace?: string | undefined }): LucidStateStore {
    return new LucidStateStore(this.db, { ...this.options, scope });
  }

  /** Fence a runs-table read to the store's scope (no-op for the operator view). */
  private fenced<Q extends { andWhere(column: string, value: unknown): unknown }>(q: Q): Q {
    if (this.scopeNamespace !== undefined) {
      (q as unknown as AnyQuery).whereIn('namespace', namespaceFilterValues(this.scopeNamespace));
    }
    return q;
  }

  /** The base query client (or a named connection's), used unless an explicit tx client is passed. */
  private client(): QueryClientContract {
    return this.connectionName ? this.db.connection(this.connectionName) : this.db.connection();
  }

  /** Idempotently provision the durable tables (called on boot when `autoSchema` is on). */
  async ensureSchema(): Promise<void> {
    await createDurableTables(
      this.db,
      this.connectionName,
      this.options.collation !== undefined ? { collation: this.options.collation } : {},
    );
  }

  // --- runs ---------------------------------------------------------------

  async createRun(run: WorkflowRun): Promise<void> {
    if (normalizeAttributeRows(run.id, run.searchAttributes).length === 0) {
      // Nothing to index: the insert, then clear any attribute rows a deleted run of this id left,
      // as two statements. The insert goes first, so a run that already exists keeps its rows.
      const client = this.client();
      await client.table(DURABLE_TABLES.runs).insert(runToRow(run));
      await client.from(DURABLE_TABLES.attributes).where('run_id', run.id).delete();
      return;
    }
    await this.client().transaction(async (trx) => {
      await trx.table(DURABLE_TABLES.runs).insert(runToRow(run));
      await this.reindexAttributes(trx, run.id, run.searchAttributes);
    });
  }

  /**
   * Run `write` in a transaction only when `patch` needs one: a terminal settle reads the run's tags
   * under a row lock to release its singleton slot, and new search attributes rewrite their rows
   * with the run's. Any other patch is one UPDATE, which needs no transaction around it.
   */
  private writeRun<T>(
    patch: Partial<WorkflowRun>,
    write: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (!settlesTerminally(patch) && !('searchAttributes' in patch)) return write(this.client());
    return this.client().transaction((trx) => write(trx));
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    await this.writeRun(patch, async (trx) => {
      const row = await this.releaseSlot(trx, runId, patch);
      // Knex throws on an empty `.update({})`; skip the UPDATE when no mapped column changed.
      if (Object.keys(row).length) {
        await trx.from(DURABLE_TABLES.runs).where('id', runId).update(row);
      }
      if ('searchAttributes' in patch) {
        await this.reindexAttributes(trx, runId, patch.searchAttributes);
      }
    });
  }

  async updateRunIf(
    runId: string,
    expectedStatuses: RunStatus[],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    return this.writeRun(patch, async (trx) => {
      const row = await this.releaseSlot(trx, runId, patch);
      let applied: boolean;
      if (Object.keys(row).length) {
        // The status predicate lives IN the UPDATE's WHERE clause, alongside `updateRun`'s existing
        // structure — the database arbitrates, not a prior JS read. Two racing writers can never both
        // report `true` for the same row.
        const affected = await trx
          .from(DURABLE_TABLES.runs)
          .where('id', runId)
          .whereIn('status', expectedStatuses)
          .update(row);
        applied = rowsAffected(affected) === 1;
      } else {
        // Knex throws on an empty `.update({})`. Nothing to write, but the predicate's outcome is
        // still observable: report whether it would have matched, without mutating anything.
        const current = await trx
          .from(DURABLE_TABLES.runs)
          .where('id', runId)
          .whereIn('status', expectedStatuses)
          .first();
        applied = !!current;
      }
      if (applied && 'searchAttributes' in patch) {
        await this.reindexAttributes(trx, runId, patch.searchAttributes);
      }
      return applied;
    });
  }

  /** Whether the runs table has `awaiting_decision_task_id`, probed once per store and cached. */
  private decisionMarkerColumn: Promise<boolean> | undefined;
  private hasDecisionMarkerColumn(trx: Client): Promise<boolean> {
    // Probed on the caller's transaction: a single-connection pool (SQLite) has no other to use.
    this.decisionMarkerColumn ??= trx.schema
      .hasColumn(DURABLE_TABLES.runs, 'awaiting_decision_task_id')
      .catch(() => {
        this.decisionMarkerColumn = undefined; // a failed probe is retried, never cached
        return true;
      });
    return this.decisionMarkerColumn;
  }

  /**
   * The row patch for `patch`, plus — when it settles the run terminally — the run's tags without the
   * singleton admission marker, so a terminal settle releases the slot. The current tags are read
   * under a row lock (Postgres/MySQL) so an admission committing concurrently can't be overwritten
   * with a stale tag list.
   */
  private async releaseSlot(
    trx: Client,
    runId: string,
    patch: Partial<WorkflowRun>,
  ): Promise<Record<string, unknown>> {
    const row = runPatchToRow(patch);
    // A patch CLEARING the remote-workflow decision marker (cancel, requeue, settle) on a schema
    // that predates the column (`autoSchema: false`, an old migration): leave it out, as `runToRow`
    // does on insert — there is nothing to clear. Setting it still needs the column.
    if (
      'awaiting_decision_task_id' in row &&
      row.awaiting_decision_task_id == null &&
      !(await this.hasDecisionMarkerColumn(trx))
    ) {
      delete row.awaiting_decision_task_id;
    }
    // Same for the refused-wake marker.
    if (
      'wake_requested_at' in row &&
      row.wake_requested_at == null &&
      !(await this.hasWakeMarkerColumnIn(trx))
    ) {
      delete row.wake_requested_at;
    }
    if (!settlesTerminally(patch)) return row;
    let tags: string[] | undefined;
    if ('tags' in patch) {
      tags = patch.tags;
    } else {
      const q = trx.from(DURABLE_TABLES.runs).where('id', runId).select('tags');
      if (locksRows(trx)) q.forUpdate();
      const current = (await q.first()) as Pick<RunRow, 'tags'> | null;
      tags = parseJsonColumn<string[]>(current?.tags, `${DURABLE_TABLES.runs}.tags`, runId);
    }
    const released = withoutAdmission(tags);
    return released ? { ...row, ...runPatchToRow({ tags: released }) } : row;
  }

  async tryAdmitSingleton(
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ): Promise<boolean> {
    return this.client().transaction(async (trx) => {
      // Every active run sharing the key. The tag LIKE may over-match (it is only a lock-scope
      // narrowing); the decision re-filters exactly.
      const sharing = () =>
        trx
          .from(DURABLE_TABLES.runs)
          .where('workflow', workflow)
          .whereIn('status', SINGLETON_ACTIVE_STATUSES)
          .whereRaw(`tags like ? escape '!'`, [`%"${escapeLike(tag)}"%`]);
      let rows: RunRow[];
      if (locksRows(trx)) {
        // Lock the key's active rows in a stable order (no lock-order deadlock between two claims).
        // A competing claim blocks here until this one commits, then reads the committed holder.
        rows = (await sharing()
          .select(SINGLETON_ADMISSION_COLUMNS)
          .orderBy('id', 'asc')
          .forUpdate()) as RunRow[];
      } else {
        // SQLite has no row locks: take the database write lock FIRST with a no-op write, then read,
        // so no other connection or process can claim between this read and the write below.
        await sharing().update({ workflow });
        rows = (await sharing().select(SINGLETON_ADMISSION_COLUMNS)) as RunRow[];
      }
      const runs = rows.map(rowToRun);
      const tags = singletonAdmissionTags(runs, runId, tag, workflow, limit);
      if (!tags) {
        const parked = singletonAdmissionDenialPatch(runs, runId, tag, workflow, retryWakeAt);
        if (parked) {
          await trx.from(DURABLE_TABLES.runs).where('id', runId).update(runPatchToRow(parked));
        }
        return false;
      }
      // Already a holder (a resumed turn): nothing to write.
      if (!runs.find((r) => r.id === runId)?.tags?.includes(SINGLETON_ADMITTED_TAG)) {
        await trx.from(DURABLE_TABLES.runs).where('id', runId).update(runPatchToRow({ tags }));
      }
      return true;
    });
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const row = await this.fenced(
      this.client().from(DURABLE_TABLES.runs).where('id', runId),
    ).first();
    return row ? rowToRun(row as RunRow) : null;
  }

  async getRuns(runIds: string[]): Promise<WorkflowRun[]> {
    const ids = [...new Set(runIds)];
    if (ids.length === 0) return [];
    const rows = await this.fenced(this.client().from(DURABLE_TABLES.runs).whereIn('id', ids));
    return (rows as RunRow[]).map(rowToRun);
  }

  async deleteRun(runId: string): Promise<void> {
    // Child rows first, then the run — checkpoints, signal waiters, attribute rows — all in one
    // transaction so a crash can't leave a half-deleted run. (Buffered signals are token-keyed,
    // not run-scoped, so they are not swept here.)
    await this.client().transaction(async (trx) => {
      await trx.from(DURABLE_TABLES.checkpoints).where('run_id', runId).delete();
      await trx.from(DURABLE_TABLES.signalWaiters).where('run_id', runId).delete();
      await trx.from(DURABLE_TABLES.attributes).where('run_id', runId).delete();
      await trx.from(DURABLE_TABLES.runs).where('id', runId).delete();
    });
  }

  async deleteRuns(runIds: string[]): Promise<void> {
    const ids = [...new Set(runIds)];
    if (ids.length === 0) return;
    // deleteRun's four statements, `IN (...)` over chunks that stay under every dialect's bind limit,
    // all in one transaction.
    await this.client().transaction(async (trx) => {
      for (let at = 0; at < ids.length; at += DELETE_RUNS_CHUNK) {
        const chunk = ids.slice(at, at + DELETE_RUNS_CHUNK);
        await trx.from(DURABLE_TABLES.checkpoints).whereIn('run_id', chunk).delete();
        await trx.from(DURABLE_TABLES.signalWaiters).whereIn('run_id', chunk).delete();
        await trx.from(DURABLE_TABLES.attributes).whereIn('run_id', chunk).delete();
        await trx.from(DURABLE_TABLES.runs).whereIn('id', chunk).delete();
      }
    });
  }

  // --- checkpoints --------------------------------------------------------

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const row = await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere('seq', seq)
      .first();
    return row ? rowToCheckpoint(row as CheckpointRow) : null;
  }

  async getCheckpoints(runId: string, seqs: number[]): Promise<StepCheckpoint[]> {
    const unique = [...new Set(seqs)];
    const out: StepCheckpoint[] = [];
    for (let at = 0; at < unique.length; at += CHECKPOINT_BATCH) {
      const rows = (await this.client()
        .from(DURABLE_TABLES.checkpoints)
        .where('run_id', runId)
        .whereIn('seq', unique.slice(at, at + CHECKPOINT_BATCH))) as CheckpointRow[];
      out.push(...rows.map(rowToCheckpoint));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async getCheckpointsForSettle(runId: string, seqs: number[]): Promise<StepCheckpoint[]> {
    const unique = [...new Set(seqs)];
    const out: StepCheckpoint[] = [];
    for (let at = 0; at < unique.length; at += CHECKPOINT_BATCH) {
      const rows = (await this.client()
        .from(DURABLE_TABLES.checkpoints)
        .where('run_id', runId)
        .whereIn('seq', unique.slice(at, at + CHECKPOINT_BATCH))
        .select(...CHECKPOINT_COLUMNS_BUT_INPUT)) as CheckpointRow[];
      out.push(...rows.map(rowToCheckpoint));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    await this.upsertCheckpoint(this.client(), checkpoint);
  }

  async saveCheckpoints(checkpoints: StepCheckpoint[]): Promise<void> {
    if (checkpoints.length === 0) return;
    // One multi-row upsert per chunk, in one transaction: a rejection writes nothing.
    await this.client().transaction(async (trx) => {
      for (let at = 0; at < checkpoints.length; at += CHECKPOINT_UPSERT_BATCH) {
        await upsertCheckpointRows(trx, checkpoints.slice(at, at + CHECKPOINT_UPSERT_BATCH));
      }
    });
  }

  async saveCheckpointIfPending(checkpoint: StepCheckpoint): Promise<boolean> {
    return updateCheckpointIfPending(this.client(), checkpoint);
  }

  async renewCheckpointLease(
    runId: string,
    seq: number,
    expectedWakeAt: number | undefined,
    wakeAt: number,
  ): Promise<boolean> {
    // One guarded UPDATE: the row-level compare-and-set is atomic on every dialect, so a result or a
    // re-dispatch committed since the caller's read makes this match nothing.
    const query = this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere('seq', seq)
      .andWhere('status', 'pending');
    if (expectedWakeAt == null) query.whereNull('wake_at');
    else query.andWhere('wake_at', expectedWakeAt);
    return rowsAffected(await query.update({ wake_at: wakeAt })) > 0;
  }

  async saveCheckpointsIfPending(checkpoints: StepCheckpoint[]): Promise<boolean[]> {
    if (checkpoints.length === 0) return [];
    // Set-based, in one transaction (a rejection writes nothing): read which of the rows are still
    // `pending` (locked, see `lockPendingCheckpoints`), decide each entry in order (a second entry
    // for a row is compared against the first one's write), then write every winner with one
    // multi-row upsert per chunk.
    return this.client().transaction(async (trx) => {
      const pending = await lockPendingCheckpoints(trx, checkpoints, ['seq']);
      const wrote: boolean[] = [];
      const writes = new Map<string, StepCheckpoint>();
      for (const cp of checkpoints) {
        const k = checkpointKey(cp.runId, cp.seq);
        if (!pending.has(k)) {
          wrote.push(false);
          continue;
        }
        wrote.push(true);
        writes.set(k, cp);
        if (cp.status !== 'pending') pending.delete(k);
      }
      const rows = [...writes.values()];
      for (let at = 0; at < rows.length; at += CHECKPOINT_UPSERT_BATCH) {
        await upsertCheckpointRows(trx, rows.slice(at, at + CHECKPOINT_UPSERT_BATCH));
      }
      return wrote;
    });
  }

  async settleCheckpointsIfPending(settlements: StepSettlement[]): Promise<boolean[]> {
    const [only] = settlements;
    if (!only) return [];
    if (settlements.length === 1) {
      const affected = await this.client()
        .from(DURABLE_TABLES.checkpoints)
        .where('run_id', only.runId)
        .andWhere('seq', only.seq)
        .andWhere('status', 'pending')
        .update(settlementToRow(only));
      return [rowsAffected(affected) > 0];
    }
    // In one transaction (a rejection writes nothing): lock the rows still `pending`, decide each
    // entry in order (a settled row makes a later entry for it lose), then write the winners with one
    // multi-row upsert per chunk that updates only the settled columns. The rows exist and are
    // locked, so the upsert never inserts: its row carries just the columns an insert would require,
    // and `input` is neither sent nor rewritten.
    return this.client().transaction(async (trx) => {
      const pending = await lockPendingCheckpoints(trx, settlements, [
        'seq',
        'name',
        'kind',
        'step_id',
        'attempts',
      ]);
      const wrote: boolean[] = [];
      const rows: Array<Record<string, unknown>> = [];
      for (const s of settlements) {
        const k = checkpointKey(s.runId, s.seq);
        const row = pending.get(k);
        wrote.push(row !== undefined);
        if (row === undefined) continue;
        pending.delete(k);
        rows.push({
          run_id: s.runId,
          seq: s.seq,
          name: row.name,
          kind: row.kind,
          step_id: row.step_id,
          attempts: row.attempts,
          ...settlementToRow(s),
        });
      }
      for (let at = 0; at < rows.length; at += CHECKPOINT_UPSERT_BATCH) {
        await trx
          .insertQuery()
          .table(DURABLE_TABLES.checkpoints)
          .knexQuery.insert(rows.slice(at, at + CHECKPOINT_UPSERT_BATCH))
          .onConflict(['run_id', 'seq'])
          .merge([...SETTLED_CHECKPOINT_COLUMNS]);
      }
      return wrote;
    });
  }

  /** Persist the latest worker heartbeat on the step's checkpoint row (see the interface doc).
   *  A targeted two-column UPDATE — never an upsert: a beat racing the checkpoint's own insert (or
   *  outliving a deleted run) matches zero rows and is a silent no-op, by design. */
  async recordStepHeartbeat(
    runId: string,
    seq: number,
    at: Date,
    progress?: unknown,
  ): Promise<void> {
    await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere('seq', seq)
      .update({
        last_heartbeat_at: at.getTime(),
        heartbeat_progress: progress === undefined ? null : JSON.stringify(progress),
      });
  }

  /**
   * Upsert a checkpoint keyed by `(run_id, seq)` — one native `INSERT … ON CONFLICT … DO UPDATE`
   * statement (portable: SQLite/Postgres upsert, MySQL `ON DUPLICATE KEY`). This is the hottest
   * write path in the system (2–3 checkpoint writes per step); the previous read-then-write
   * transaction cost `BEGIN + SELECT + write + COMMIT` — four round trips — per save.
   */
  private async upsertCheckpoint(client: Client, checkpoint: StepCheckpoint): Promise<void> {
    const row = checkpointToRow(checkpoint);
    await client
      .insertQuery()
      .table(DURABLE_TABLES.checkpoints)
      .knexQuery.insert(row)
      .onConflict(['run_id', 'seq'])
      .merge();
  }

  // --- recovery / dispatch queries ----------------------------------------

  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    const q = this.fenced(this.client().from(DURABLE_TABLES.runs).where('status', 'running'));
    if (namespace !== undefined) q.whereIn('namespace', namespaceFilterValues(namespace));
    const rows = await q;
    return (rows as RunRow[]).map(rowToRun);
  }

  async listOrphanedRuns(
    nowMs: number,
    limit: number,
    namespace?: string,
    owner?: string,
  ): Promise<WorkflowRun[]> {
    // The lease predicate lives IN the query: only genuinely orphaned runs (no lease, or an expired
    // one) come back, so a healthy fleet's recovery tick fetches ~zero rows instead of every
    // running run — and issues ~zero lock-probe UPDATEs. `owner` adds the runs still leased to that
    // instance id (a rebooted instance's own leftovers; the engine filters what it is executing).
    const q = this.fenced(
      this.client()
        .from(DURABLE_TABLES.runs)
        .where('status', 'running')
        .andWhere((sub) => {
          sub.whereNull('locked_until').orWhere('locked_until', '<=', nowMs);
          if (owner !== undefined) sub.orWhere('locked_by', owner);
        }),
    );
    if (namespace !== undefined) q.whereIn('namespace', namespaceFilterValues(namespace));
    const rows = await q.orderBy('created_at', 'asc').limit(limit);
    return (rows as RunRow[]).map(rowToRun);
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    const q = this.fenced(this.client().from(DURABLE_TABLES.runs).where('status', 'pending'));
    if (namespace !== undefined) q.whereIn('namespace', namespaceFilterValues(namespace));
    const rows = await q
      .orderBy('created_at', 'asc') // FIFO dispatch
      .orderBy('id', 'asc') // stable tiebreak, mirrors the in-memory store
      .limit(limit);
    return (rows as RunRow[]).map(rowToRun);
  }

  async listDueTimers(nowMs: number, namespace?: string, limit?: number): Promise<WorkflowRun[]> {
    const marker = await this.hasWakeMarkerColumn();
    const q = this.fenced(
      this.client()
        .from(DURABLE_TABLES.runs)
        .where('status', 'suspended')
        .where((w) => {
          w.where((d) => d.whereNotNull('wake_at').andWhere('wake_at', '<=', nowMs));
          // A refused wake asked for a turn: due now, whatever the run's timer says.
          if (marker) w.orWhereNotNull('wake_requested_at');
        }),
    );
    if (namespace !== undefined) q.whereIn('namespace', namespaceFilterValues(namespace));
    // Most overdue first, bounded: a backlog drains over several polls instead of one unbounded
    // fetch (served by the existing (status, wake_at) index).
    q.orderBy('wake_at', 'asc');
    if (limit !== undefined) q.limit(limit);
    const rows = await q;
    return (rows as RunRow[]).map(rowToRun);
  }

  // --- recovery lease (atomic) --------------------------------------------

  async tryLockRun(
    runId: string,
    owner: string,
    leaseUntilMs: number,
    nowMs: number,
  ): Promise<boolean> {
    // Atomic compare-and-set: acquire ONLY if currently unlocked or the lease has expired. The single
    // conditional UPDATE is the concurrency guard — two instances racing can never both report `true`.
    const affected = await this.client()
      .from(DURABLE_TABLES.runs)
      .where('id', runId)
      .andWhere((q) => {
        q.whereNull('locked_until').orWhere('locked_until', '<=', nowMs);
      })
      .update({ locked_by: owner, locked_until: leaseUntilMs });
    return rowsAffected(affected) === 1;
  }

  async releaseRunLock(runId: string, owner?: string): Promise<void> {
    // Owner-scoped release (when `owner` is given): the `locked_by` predicate lives in the UPDATE's
    // WHERE clause, so a stale executor whose lease was taken over matches zero rows and cannot
    // wipe the new owner's lease — same conditional-write shape as renewRunLock.
    const q = this.client().from(DURABLE_TABLES.runs).where('id', runId);
    if (owner !== undefined) q.andWhere('locked_by', owner);
    await q.update({ locked_by: null, locked_until: null });
  }

  async releaseRunLockUnlessWakeRequested(runId: string, owner: string): Promise<boolean> {
    // One conditional UPDATE: a marker a refused wake set after the holder's last look keeps the
    // lease where it is, and the holder runs another turn.
    const marker = await this.hasWakeMarkerColumn();
    const q = this.client()
      .from(DURABLE_TABLES.runs)
      .where('id', runId)
      .andWhere('locked_by', owner);
    if (marker) q.whereNull('wake_requested_at');
    const affected = await q.update({ locked_by: null, locked_until: null });
    if (rowsAffected(affected) === 1) return true;
    // Nothing matched: the lease is not ours (any more), or a turn was asked for.
    const row = (await this.client()
      .from(DURABLE_TABLES.runs)
      .where('id', runId)
      .select('locked_by')
      .first()) as Pick<RunRow, 'locked_by'> | null;
    return row?.locked_by !== owner;
  }

  /** {@link hasWakeMarkerColumn} on the caller's transaction (a single-connection pool has no other). */
  private hasWakeMarkerColumnIn(trx: Client): Promise<boolean> {
    this.wakeMarkerColumn ??= trx.schema
      .hasColumn(DURABLE_TABLES.runs, 'wake_requested_at')
      .catch(() => {
        this.wakeMarkerColumn = undefined;
        return false;
      });
    return this.wakeMarkerColumn;
  }

  /** Whether the runs table has `wake_requested_at`, probed once per store and cached. */
  private wakeMarkerColumn: Promise<boolean> | undefined;
  private hasWakeMarkerColumn(): Promise<boolean> {
    this.wakeMarkerColumn ??= this.client()
      .schema.hasColumn(DURABLE_TABLES.runs, 'wake_requested_at')
      .catch(() => {
        this.wakeMarkerColumn = undefined;
        return false;
      });
    return this.wakeMarkerColumn;
  }

  async renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    // Extend ONLY if `owner` still holds the lease — a dead worker's lease still expires & is reclaimed.
    const affected = await this.client()
      .from(DURABLE_TABLES.runs)
      .where('id', runId)
      .andWhere('locked_by', owner)
      .update({ locked_until: leaseUntilMs });
    return rowsAffected(affected) === 1;
  }

  // --- signal waiters -----------------------------------------------------

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    // Native upsert keyed by the `token` PK — one statement instead of a read-then-write tx (this
    // runs once per wait registration, i.e. on every signal/child/event suspension).
    await this.client()
      .insertQuery()
      .table(DURABLE_TABLES.signalWaiters)
      .knexQuery.insert({
        token: waiter.token,
        run_id: waiter.runId,
        seq: waiter.seq,
        parallel_group: waiter.parallelGroup ?? null,
      })
      .onConflict('token')
      .merge();
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    // Take-and-remove: the row is ours only if our DELETE removed it, so a concurrent take can't hand
    // the same waiter to two callers. The DELETE arbitrates, so no transaction is needed around it,
    // and a token with no waiter (the common case) costs one read.
    const client = this.client();
    const row = await client.from(DURABLE_TABLES.signalWaiters).where('token', token).first();
    if (!row) return null;
    const deleted = await client.from(DURABLE_TABLES.signalWaiters).where('token', token).delete();
    if (rowsAffected(deleted) !== 1) return null;
    return rowToSignalWaiter(
      row as { token: string; run_id: string; seq: number | string; parallel_group?: unknown },
    );
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    // The prefix embeds caller-supplied names (event names via eventPrefix) — escape their LIKE
    // metacharacters so a name containing `%`/`_` can't scan (or match) other tokens.
    const rows = await this.client()
      .from(DURABLE_TABLES.signalWaiters)
      .whereRaw(`token like ? escape '!'`, [`${escapeLike(prefix)}%`]);
    return (
      rows as Array<{
        token: string;
        run_id: string;
        seq: number | string;
        parallel_group?: unknown;
      }>
    ).map(rowToSignalWaiter);
  }

  async listSignalWaitersByRunIds(runIds: string[]): Promise<SignalWaiter[]> {
    if (runIds.length === 0) return [];
    const rows = await this.client().from(DURABLE_TABLES.signalWaiters).whereIn('run_id', runIds);
    return (
      rows as Array<{
        token: string;
        run_id: string;
        seq: number | string;
        parallel_group?: unknown;
      }>
    ).map(rowToSignalWaiter);
  }

  async hasSignalWaiter(runId: string, tokenPrefix: string): Promise<boolean> {
    // The escaped LIKE makes `%`/`_` literal, but its case sensitivity is the dialect's (SQLite and
    // MySQL's default collations ignore case), so a hit is confirmed in JS. Only a match that is not
    // a real prefix match pays for reading the run's whole matching set.
    const matching = () =>
      this.client()
        .from(DURABLE_TABLES.signalWaiters)
        .select('token')
        .where('run_id', runId)
        .andWhereRaw(`token like ? escape '!'`, [`${escapeLike(tokenPrefix)}%`]);
    const first = (await matching().first()) as { token: string } | null;
    if (!first) return false;
    if (first.token.startsWith(tokenPrefix)) return true;
    const rows = (await matching()) as Array<{ token: string }>;
    return rows.some((r) => r.token.startsWith(tokenPrefix));
  }

  async registerChildWaits(entries: ChildWait[]): Promise<void> {
    if (entries.length === 0) return;
    // Waiters before placeholders, in one transaction: the engine reads a placeholder as proof its
    // waiter exists. Split into statements of CHILD_WAIT_ROWS rows to stay under every dialect's
    // bind-parameter limit.
    await this.client().transaction(async (trx) => {
      for (let at = 0; at < entries.length; at += CHILD_WAIT_ROWS) {
        const chunk = entries.slice(at, at + CHILD_WAIT_ROWS);
        await trx
          .insertQuery()
          .table(DURABLE_TABLES.signalWaiters)
          .knexQuery.insert(
            chunk.map(({ waiter }) => ({
              token: waiter.token,
              run_id: waiter.runId,
              seq: waiter.seq,
              parallel_group: waiter.parallelGroup ?? null,
            })),
          )
          .onConflict('token')
          .merge();
      }
      for (let at = 0; at < entries.length; at += CHILD_WAIT_ROWS) {
        const chunk = entries.slice(at, at + CHILD_WAIT_ROWS);
        await trx
          .insertQuery()
          .table(DURABLE_TABLES.checkpoints)
          .knexQuery.insert(chunk.map(({ checkpoint }) => checkpointToRow(checkpoint)))
          .onConflict(['run_id', 'seq'])
          .merge();
      }
    });
  }

  async compactCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    into: StepCheckpoint,
  ): Promise<void> {
    await this.client().transaction(async (trx) => {
      await trx
        .from(DURABLE_TABLES.checkpoints)
        .where('run_id', runId)
        .andWhere('seq', '>=', fromSeq)
        .andWhere('seq', '<=', toSeq)
        .delete();
      await this.upsertCheckpoint(trx, into);
    });
  }

  async removeSignalWaiter(waiter: SignalWaiter): Promise<void> {
    // Exact match on (token, run_id, seq): only delete the row THIS caller registered. `token` is the
    // primary key, so a later putSignalWaiter for the same token may have replaced the row with a
    // different run's waiter — the run_id/seq predicate leaves that one untouched. No-op if absent.
    await this.client()
      .from(DURABLE_TABLES.signalWaiters)
      .where('token', waiter.token)
      .andWhere('run_id', waiter.runId)
      .andWhere('seq', waiter.seq)
      .delete();
  }

  // --- buffered signals (FIFO per token) ----------------------------------

  async bufferSignal(token: string, payload: unknown): Promise<void> {
    await this.client()
      .table(DURABLE_TABLES.bufferedSignals)
      .insert({ token, payload: payload === undefined ? null : JSON.stringify(payload) });
  }

  async listBufferedSignalTokens(prefix: string, limit: number): Promise<string[]> {
    const rows = (await this.client()
      .from(DURABLE_TABLES.bufferedSignals)
      .whereRaw(`token like ? escape '!'`, [`${escapeLike(prefix)}%`])
      .distinct('token')
      .orderBy('token', 'asc')
      .limit(limit)) as Array<{ token: string }>;
    return rows.map((r) => r.token);
  }

  async listBufferedSignals(
    tokenPrefix: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<BufferedSignalRow[]> {
    const q = this.client()
      .from(DURABLE_TABLES.bufferedSignals)
      .whereRaw(`token like ? escape '!'`, [`${escapeLike(tokenPrefix)}%`]);
    if (afterId !== undefined) q.where('id', '>', Number(afterId));
    const rows = (await q.orderBy('id', 'asc').limit(limit)) as Array<{
      id: number | string;
      token: string;
      payload: string | null;
    }>;
    return rows
      .filter((row) => row.token.startsWith(tokenPrefix))
      .map((row) => ({
        id: String(row.id),
        token: row.token,
        payload: parseJsonColumn(
          row.payload,
          `${DURABLE_TABLES.bufferedSignals}.payload`,
          String(row.id),
        ),
      }));
  }

  async deleteBufferedSignals(ids: string[]): Promise<void> {
    for (let at = 0; at < ids.length; at += 500) {
      await this.client()
        .from(DURABLE_TABLES.bufferedSignals)
        .whereIn(
          'id',
          ids.slice(at, at + 500).map((id) => Number(id)),
        )
        .delete();
    }
  }

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    // The oldest signal is ours only if our DELETE removed it, so two takers never get the same one;
    // that needs no transaction, and a token with nothing buffered (the common case) costs one read.
    const client = this.client();
    const row = await client
      .from(DURABLE_TABLES.bufferedSignals)
      .where('token', token)
      .orderBy('id', 'asc')
      .first();
    if (!row) return null;
    const r = row as { id: number | string; payload: string | null };
    const deleted = await client.from(DURABLE_TABLES.bufferedSignals).where('id', r.id).delete();
    if (rowsAffected(deleted) !== 1) return null;
    return {
      payload: parseJsonColumn(
        r.payload,
        `${DURABLE_TABLES.bufferedSignals}.payload`,
        String(r.id),
      ),
    };
  }

  // --- buffered events (name-keyed, match-based consumption) ---------------

  async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    await this.client()
      .table(DURABLE_TABLES.bufferedEvents)
      .insert({
        id: input.id,
        name: input.name,
        payload: input.payload === undefined ? null : JSON.stringify(input.payload),
        published_at: input.publishedAt,
      });
  }

  async listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>> {
    const rows = await this.client()
      .from(DURABLE_TABLES.bufferedEvents)
      .where('name', name)
      .orderBy('published_at', 'asc') // oldest first
      .limit(limit);
    return (
      rows as Array<{ id: string; payload: string | null; published_at: number | string }>
    ).map((r) => ({
      id: r.id,
      payload: parseJsonColumn(r.payload, `${DURABLE_TABLES.bufferedEvents}.payload`, r.id),
      publishedAt: Number(r.published_at),
    }));
  }

  async pruneBufferedEvents(publishedBefore: number, limit: number): Promise<number> {
    if (!(limit > 0)) return 0;
    // Two statements, not `DELETE ... WHERE id IN (SELECT ... LIMIT n)`: MySQL rejects a LIMIT in an
    // IN subquery. The age predicate is repeated on the DELETE so a row re-published under the same
    // id meanwhile is left alone.
    const rows = (await this.client()
      .from(DURABLE_TABLES.bufferedEvents)
      .select('id')
      .where('published_at', '<', publishedBefore)
      .orderBy('published_at', 'asc')
      .limit(limit)) as Array<{ id: string }>;
    if (rows.length === 0) return 0;
    const deleted = await this.client()
      .from(DURABLE_TABLES.bufferedEvents)
      .whereIn(
        'id',
        rows.map((r) => r.id),
      )
      .andWhere('published_at', '<', publishedBefore)
      .delete();
    return rowsAffected(deleted);
  }

  async removeBufferedEvent(id: string): Promise<boolean> {
    // Atomic claim: whoever's delete affects the row (returns 1) is the one that gets to deliver;
    // a concurrent claimant sees 0 and backs off. `id` is the primary key.
    const deleted = await this.client()
      .from(DURABLE_TABLES.bufferedEvents)
      .where('id', id)
      .delete();
    return rowsAffected(deleted) === 1;
  }

  // --- transaction (exactly-once business write + checkpoint) -------------

  async transaction<T>(
    work: (tx: {
      raw: unknown;
      saveCheckpoint: (cp: StepCheckpoint) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.client().transaction(async (trx) =>
      work({
        raw: trx,
        // Same native upsert as the standalone path, committed inside THIS transaction.
        saveCheckpoint: async (cp) => {
          await this.upsertCheckpoint(trx, cp);
        },
      }),
    );
  }

  // --- dashboard queries --------------------------------------------------

  /** One `GROUP BY status, origin` over the same predicates {@link listRuns} applies. */
  async runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    const rows = (await this.scopedRuns(query)
      .select('status', 'origin')
      .count('* as count')
      .groupBy('status', 'origin')) as Array<{
      status: RunStatus;
      origin: string | null;
      count: number | string;
    }>;
    return mergeRunFacetRows(
      rows.map((row) => ({ status: row.status, origin: row.origin, count: Number(row.count) })),
    );
  }

  /** One `COUNT(*)` over the same predicates {@link listRuns} applies. */
  async countRuns(query: Omit<RunQuery, 'page' | 'size'>): Promise<number> {
    const rows = await this.scopedRuns(query).count('* as count');
    return Number((rows as Array<{ count: number | string }>)[0]?.count ?? 0);
  }

  // ---- persisted schedules ----------------------------------------------------------------------

  async saveSchedule(record: ScheduleRecord): Promise<void> {
    const row = scheduleToRow(record);
    await this.client()
      .insertQuery()
      .table(DURABLE_TABLES.schedules)
      .knexQuery.insert(row)
      .onConflict('id')
      .merge();
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const row = await this.client().from(DURABLE_TABLES.schedules).where('id', id).first();
    return row ? rowToSchedule(row as ScheduleRow) : null;
  }

  /** One conditional UPDATE: the compare-and-set on `next_fire_at` lives in its WHERE clause. */
  async updateSchedule(
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt'>>,
    expectedNextFireAt?: number | null,
  ): Promise<boolean> {
    const set: Record<string, unknown> = {};
    if (patch.namespace !== undefined) set.namespace = normalizeNamespace(patch.namespace);
    if (patch.workflow !== undefined) set.workflow = patch.workflow;
    if (patch.paused !== undefined) set.paused = patch.paused;
    if ('nextFireAt' in patch) set.next_fire_at = patch.nextFireAt ?? null;
    if ('tags' in patch) set.tags = patch.tags ? JSON.stringify(patch.tags) : null;
    if (patch.spec !== undefined) set.spec = JSON.stringify(patch.spec);
    if (patch.state !== undefined) set.state = JSON.stringify(patch.state);
    if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt.getTime();
    if (!Object.keys(set).length) return (await this.getSchedule(id)) !== null;
    const q = this.client().from(DURABLE_TABLES.schedules).where('id', id);
    if (expectedNextFireAt === null) q.whereNull('next_fire_at');
    else if (expectedNextFireAt !== undefined) q.where('next_fire_at', expectedNextFireAt);
    return rowsAffected(await q.update(set)) > 0;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const affected = await this.client().from(DURABLE_TABLES.schedules).where('id', id).delete();
    return rowsAffected(affected) > 0;
  }

  async listSchedules(query: ScheduleQuery): Promise<ScheduleRecord[]> {
    const q = this.client().from(DURABLE_TABLES.schedules);
    if (query.namespace !== undefined) {
      q.whereIn('namespace', namespaceFilterValues(query.namespace));
    }
    if (query.workflow !== undefined) q.where('workflow', query.workflow);
    if (query.paused !== undefined) q.where('paused', query.paused);
    if (query.tag !== undefined) {
      q.whereRaw(`tags like ? escape '!'`, [`%"${escapeLike(query.tag)}"%`]);
    }
    if (query.dueBy !== undefined) {
      q.where('paused', false)
        .whereNotNull('next_fire_at')
        .where('next_fire_at', '<=', query.dueBy);
    }
    // Soonest-due first, never-firing (NULL) last, id as the stable tie-break.
    q.orderByRaw('case when next_fire_at is null then 1 else 0 end asc')
      .orderBy('next_fire_at', 'asc')
      .orderBy('id', 'asc');
    if (query.limit != null) q.limit(query.limit);
    if (query.offset) q.offset(query.offset);
    return ((await q) as ScheduleRow[]).map(rowToSchedule);
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const q = this.scopedRuns(query);

    q.orderBy('created_at', 'desc'); // newest first — recent runs on top in the dashboard
    // The 1-based `page`/`size` the caller speaks becomes SQL's 0-based window HERE — the only
    // place this adapter knows about an offset at all (see `runPageWindow`).
    const { limit, offset } = runPageWindow(query);
    if (limit !== undefined) q.limit(limit);
    if (offset > 0) q.offset(offset);

    const rows = await q;
    return (rows as RunRow[]).map(rowToRun);
  }

  /**
   * The distinct values of ONE filter axis over the runs matching `query`, with counts — what a
   * console's pickers list.
   *
   * Column axes (`workflow`/`status`/`namespace`) are a `GROUP BY` over the whole matching set, so
   * their counts are exact. `tag` and the attribute axes live in a JSON column and a side table with
   * no portable expansion across SQLite/Postgres/MySQL, so they are counted in-process over a
   * bounded scan of the newest matching runs — approximate by design (see `scanRunValueFacets`).
   */
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    const limit = Math.max(0, opts?.limit ?? RUN_VALUE_FACET_LIMIT);
    if (limit === 0) return [];
    if (!axisIsRunColumn(axis)) {
      // `scanRunValueFacets`' window (`listRuns` page 1 of `scan`, newest first), reading only the
      // columns the count looks at instead of every run's payloads.
      const { limit: scan } = runPageWindow({ page: 1, size: opts?.scan ?? RUN_VALUE_FACET_SCAN });
      const q = this.scopedRuns(query).select(RUN_VALUE_SCAN_COLUMNS).orderBy('created_at', 'desc');
      if (scan !== undefined) q.limit(scan);
      return runValueFacetsFromRuns(((await q) as RunRow[]).map(rowToRun), axis, opts);
    }
    const column = axis.field;
    const needle = opts?.search?.trim().toLowerCase();
    // One pass over the matching runs (the shape `runFacets` uses), not a self semi-join on `id`.
    const q = this.scopedRuns(query)
      .select(`${column} as value`)
      .count('* as count')
      .groupBy(column);
    if (needle) q.andWhereRaw(`lower(${column}) like ? escape '!'`, [`%${escapeLike(needle)}%`]);
    const rows = (await q) as Array<{ value: string | null; count: number | string }>;
    return mergeRunValueFacetRows(
      rows.map((row) => ({
        // A legacy '' namespace counts as the default pool, as everywhere else.
        value: column === 'namespace' ? normalizeNamespace(row.value) : row.value,
        count: Number(row.count),
      })),
      { ...opts, search: undefined },
    );
  }

  /**
   * The runs matching `query`'s predicates (no ordering, no paging) — one source of truth shared by
   * {@link listRuns} and {@link runValueFacets}, so the values a picker offers are counted over
   * exactly the set the list would show.
   */
  private scopedRuns(query: RunFacetQuery & Pick<RunQuery, 'status' | 'statuses'>): AnyQuery {
    const q: AnyQuery = this.fenced(this.client().from(DURABLE_TABLES.runs));

    if (query.workflow) q.where('workflow', query.workflow);
    if (query.workflows) {
      // `workflow IN (...)`; an empty set matches nothing (mirrors the in-memory store).
      if (query.workflows.length) q.whereIn('workflow', query.workflows);
      else q.whereRaw('1 = 0');
    }
    if (query.namespace !== undefined) {
      q.whereIn('namespace', namespaceFilterValues(query.namespace));
    }
    if (query.namespaces) {
      if (query.namespaces.length) {
        q.whereIn('namespace', query.namespaces.flatMap(namespaceFilterValues));
      } else q.whereRaw('1 = 0');
    }
    if (query.origin) q.where('origin', query.origin);
    if (query.status) q.where('status', query.status);
    if (query.statuses) {
      // `status IN (...)`; an empty set matches nothing (mirrors the in-memory store).
      if (query.statuses.length) q.whereIn('status', query.statuses);
      else q.whereRaw('1 = 0');
    }
    // `tags` is stored as a JSON array string; match the quoted token so `etl` doesn't match `etl-foo`.
    // LIKE metacharacters in the tag VALUE are escaped so `50%_off` matches itself, not a pattern.
    if (query.tag) q.whereRaw(`tags like ? escape '!'`, [`%"${escapeLike(query.tag)}"%`]);
    if (query.tags) {
      if (query.tags.length) {
        q.andWhere((or: AnyQuery) => {
          for (const tag of query.tags as string[]) {
            or.orWhereRaw(`tags like ? escape '!'`, [`%"${escapeLike(tag)}"%`]);
          }
        });
      } else q.whereRaw('1 = 0');
    }

    // Time-range and due-timer predicates push down too (the sweep/recovery poll paths lean on
    // these instead of fetching every in-flight run and comparing in process).
    if (query.createdBefore !== undefined) q.where('created_at', '<=', query.createdBefore);
    if (query.createdAfter !== undefined) q.where('created_at', '>=', query.createdAfter);
    if (query.updatedBefore !== undefined) q.where('updated_at', '<=', query.updatedBefore);
    if (query.wakeBefore !== undefined) {
      q.whereNotNull('wake_at').where('wake_at', '<=', query.wakeBefore);
    }

    // Typed/range attribute predicates push DOWN into SQL via one EXISTS per filter against the
    // normalized side-table — so the DB filters AND paginates, no full scan + in-process filter.
    if (query.attributes?.length) {
      for (const f of query.attributes) this.applyAttributeExists(q, f);
    }
    return q;
  }

  /**
   * Add one attribute predicate as a correlated EXISTS subquery on the side-table. `<>` (ne) also
   * excludes runs where the attribute is absent (the missing-key-never-matches contract): EXISTS
   * already requires the key row present, so EXISTS(... <> ...) is exactly ne-with-present. Numeric
   * operands compare `num_value`, everything else `str_value`. `in` becomes one EXISTS with a
   * `WHERE IN` over the set — an OR inside a single predicate, which ANDed `eq`s cannot express.
   */
  private applyAttributeExists(q: AnyQuery, f: AttributeFilter): void {
    const col = attributeColumnFor(f) === 'numValue' ? 'num_value' : 'str_value';
    if (f.op === 'in') {
      const operands = attributeOperands(f);
      // An empty set matches nothing — and `WHERE IN ()` is invalid SQL, so spell it directly.
      if (operands.length === 0) {
        q.whereRaw('1 = 0');
        return;
      }
      q.whereExists((sub: AnyQuery) => {
        sub
          .from(DURABLE_TABLES.attributes)
          .whereRaw(`${DURABLE_TABLES.attributes}.run_id = ${DURABLE_TABLES.runs}.id`)
          .andWhere(`${DURABLE_TABLES.attributes}.key`, f.key)
          .whereIn(`${DURABLE_TABLES.attributes}.${col}`, operands);
      });
      return;
    }
    const cmp = sqlComparator(f.op);
    const operand = attributeOperand(f);
    q.whereExists((sub: AnyQuery) => {
      sub
        .from(DURABLE_TABLES.attributes)
        .whereRaw(`${DURABLE_TABLES.attributes}.run_id = ${DURABLE_TABLES.runs}.id`)
        .andWhere(`${DURABLE_TABLES.attributes}.key`, f.key)
        .andWhere(`${DURABLE_TABLES.attributes}.${col}`, cmp, operand);
    });
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    const rows = await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .orderBy('seq', 'asc');
    return (rows as CheckpointRow[]).map(rowToCheckpoint);
  }

  async listCheckpointsForReplay(runId: string): Promise<StepCheckpoint[]> {
    const rows = (await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .orderBy('seq', 'asc')
      .select(...CHECKPOINT_COLUMNS_BUT_INPUT)) as CheckpointRow[];
    // The input of every row but a completed one, read by seq: a row that completed since the read
    // above still gets its input, as that read reported it unsettled.
    const unsettled = rows
      .filter((row) => row.status !== 'completed')
      .map((row) => Number(row.seq));
    if (unsettled.length > 0) {
      const inputs = new Map<number, string | null>();
      for (let at = 0; at < unsettled.length; at += CHECKPOINT_BATCH) {
        const found = (await this.client()
          .from(DURABLE_TABLES.checkpoints)
          .where('run_id', runId)
          .whereIn('seq', unsettled.slice(at, at + CHECKPOINT_BATCH))
          .select('seq', 'input')) as Array<{ seq: number | string; input: string | null }>;
        for (const { seq, input } of found) inputs.set(Number(seq), input);
      }
      for (const row of rows) {
        if (row.status !== 'completed') row.input = inputs.get(Number(row.seq)) ?? null;
      }
    }
    return rows.map(rowToCheckpoint);
  }

  async getLatestCheckpointByName(
    runId: string,
    name: string,
  ): Promise<StepCheckpoint | undefined> {
    const row = await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere('name', name)
      .orderBy('seq', 'desc')
      .first();
    return row ? rowToCheckpoint(row as CheckpointRow) : undefined;
  }

  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    if (prefixes.length === 0) return [];
    const rows = await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere((q) => {
        for (const p of prefixes) q.orWhereRaw(`name like ? escape '!'`, [`${escapeLike(p)}%`]);
      })
      .orderBy('seq', 'asc');
    return (rows as CheckpointRow[]).map(rowToCheckpoint);
  }

  async countCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ): Promise<number> {
    if (statuses.length === 0) return 0;
    const rows = await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere('seq', '>=', fromSeq)
      .andWhere('seq', '<=', toSeq)
      .whereIn('status', statuses)
      .count('* as count');
    return Number((rows as Array<{ count: number | string }>)[0]?.count ?? 0);
  }

  /** The highest matching seq through the `(run_id, seq)` primary key, read downward, `LIMIT 1`. */
  async hasCheckpoints(
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ): Promise<boolean> {
    if (statuses.length === 0) return false;
    const row = await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .select('seq')
      .where('run_id', runId)
      .andWhere('seq', '>=', fromSeq)
      .andWhere('seq', '<=', toSeq)
      .whereIn('status', statuses)
      .orderBy('seq', 'desc')
      .first();
    return row !== undefined && row !== null;
  }

  /**
   * One `GROUP BY parallel_group, status, <name kind>` over the run's checkpoints — the buckets a run
   * detail summarizes a fan from, without loading its rows. The name-kind `CASE` is the SQL of
   * `checkpointNameKind` (case-sensitive prefix tests, like `startsWith`), and
   * `min(coalesce(enqueued_at, started_at))` reads `enqueuedAt` the way {@link listCheckpoints} does.
   */
  async checkpointStats(
    runId: string,
    opts?: { group?: string | undefined },
  ): Promise<CheckpointStat[]> {
    const client = this.client();
    const kind = nameKindSql(client.dialect.name);
    const q = client
      .from(DURABLE_TABLES.checkpoints)
      .select('parallel_group as grp', 'status')
      .select(client.raw(`${kind} as name_kind`))
      .count('* as n')
      .min('seq as min_seq')
      .max('seq as max_seq')
      .min('name as min_name')
      .max('name as max_name')
      .select(client.raw('min(coalesce(enqueued_at, started_at)) as min_enqueued_at'))
      .min('started_at as min_started_at')
      .max('started_at as max_started_at')
      .max('finished_at as max_finished_at')
      .sum('attempts as sum_attempts')
      .where('run_id', runId);
    if (opts?.group !== undefined) q.andWhere('parallel_group', opts.group);
    q.groupBy('parallel_group', 'status').groupByRaw(kind);
    const rows = (await q) as Array<Record<string, unknown>>;
    // Counts, sums and bigint aggregates come back as strings on Postgres/MySQL.
    const ms = (value: unknown) => new Date(Number(value));
    return rows.map((row) => ({
      group: (row.grp as string | null) ?? null,
      status: row.status as StepCheckpoint['status'],
      nameKind: row.name_kind as CheckpointNameKind,
      count: Number(row.n),
      minSeq: Number(row.min_seq),
      maxSeq: Number(row.max_seq),
      minName: String(row.min_name),
      maxName: String(row.max_name),
      minEnqueuedAt: ms(row.min_enqueued_at),
      minStartedAt: ms(row.min_started_at),
      maxStartedAt: ms(row.max_started_at),
      maxFinishedAt: ms(row.max_finished_at),
      sumAttempts: Number(row.sum_attempts),
    }));
  }

  /**
   * The run's checkpoints matching `query`, in `seq` order and paged in the database — a fan's
   * failures or one page of its members without the rest of the run. An excluded group keeps the
   * ungrouped rows (`parallel_group is null or not in (...)`); an empty `statuses`/`namePrefixes`
   * matches nothing, so it returns before querying.
   */
  async queryCheckpoints(runId: string, query: CheckpointQuery): Promise<StepCheckpoint[]> {
    if (query.statuses?.length === 0 || query.namePrefixes?.length === 0) return [];
    const client = this.client();
    const q = client.from(DURABLE_TABLES.checkpoints).where('run_id', runId);
    if (query.group !== undefined) q.andWhere('parallel_group', query.group);
    if (query.excludeGroups?.length) {
      const excluded = query.excludeGroups;
      q.andWhere((sub) => {
        sub.whereNull('parallel_group').orWhereNotIn('parallel_group', excluded);
      });
    }
    if (query.statuses) q.whereIn('status', query.statuses);
    if (query.namePrefixes) {
      const prefixes = query.namePrefixes;
      const dialect = client.dialect.name;
      q.andWhere((sub) => {
        for (const prefix of prefixes) {
          sub.orWhereRaw(prefixSql(dialect, 'name', prefix), [prefix]);
        }
      });
    }
    q.orderBy('seq', 'asc');
    if (query.limit !== undefined) q.limit(query.limit);
    if (query.offset) {
      // An OFFSET alone is not valid SQL on SQLite/MySQL; an unbounded page gets a limit no run reaches.
      if (query.limit === undefined) q.limit(Number.MAX_SAFE_INTEGER);
      q.offset(query.offset);
    }
    return ((await q) as CheckpointRow[]).map(rowToCheckpoint);
  }

  // --- internals ----------------------------------------------------------

  /** Rewrite a run's normalized attribute rows: delete the old set, insert the current one. Mirrors
   *  the in-memory store's reindex so the side-table always reflects the run's live searchAttributes. */
  private async reindexAttributes(
    client: Client,
    runId: string,
    attributes: WorkflowRun['searchAttributes'],
  ): Promise<void> {
    await client.from(DURABLE_TABLES.attributes).where('run_id', runId).delete();
    const rows = normalizeAttributeRows(runId, attributes);
    if (rows.length) {
      await client.table(DURABLE_TABLES.attributes).multiInsert(
        rows.map((r) => ({
          run_id: r.runId,
          key: r.key,
          str_value: r.strValue,
          num_value: r.numValue,
        })),
      );
    }
  }
}

/**
 * Escape LIKE metacharacters (`%`, `_`) — and the escape character itself — using `!` as the ESCAPE
 * char. `!` because a backslash inside a SQL string literal is dialect-divergent (MySQL treats it as
 * its own string escape; SQLite has no default LIKE escape at all), while `'!'` is byte-identical
 * everywhere. Pair every use with `ESCAPE '!'`. Without this, a tag or picker-search value
 * containing `%`/`_` silently widened (or broke) the match.
 */
/** Rows per multi-row INSERT in {@link LucidStateStore.registerChildWaits}. */
const CHILD_WAIT_ROWS = 100;

/** Run ids per `IN (...)` in {@link LucidStateStore.deleteRuns}. */
const DELETE_RUNS_CHUNK = 500;

/**
 * The run columns the singleton admission decision reads (id, workflow, status, tags, creation
 * order) plus the ones `rowToRun` always maps. Read under `FOR UPDATE` for every waiter of the key,
 * so leaving out the payload columns (`input`/`output`/`error`) saves moving and parsing them.
 */
const SINGLETON_ADMISSION_COLUMNS = [
  'id',
  'workflow',
  'workflow_version',
  'status',
  'namespace',
  'tags',
  'created_at',
  'updated_at',
];

/**
 * The run columns the tag/attribute value pickers read (`tags`, `search_attributes`) plus the ones
 * `rowToRun` always maps: a picker scans thousands of runs and never looks at their payloads.
 */
const RUN_VALUE_SCAN_COLUMNS = [
  'id',
  'workflow',
  'workflow_version',
  'status',
  'namespace',
  'tags',
  'search_attributes',
  'created_at',
  'updated_at',
];

/**
 * One conditional UPDATE: the `status = 'pending'` predicate is the compare, the affected-row count
 * the answer. A missing row matches nothing, so it is never created.
 */
/** Most seqs one `IN (...)` read of checkpoints carries. */
const CHECKPOINT_BATCH = 500;
/** Most checkpoint rows one multi-row upsert writes (kept under every dialect's bind limit). */
const CHECKPOINT_UPSERT_BATCH = 200;

/** One multi-row `INSERT … ON CONFLICT (run_id, seq) DO UPDATE` (MySQL: `ON DUPLICATE KEY`). */
async function upsertCheckpointRows(client: Client, checkpoints: StepCheckpoint[]): Promise<void> {
  if (checkpoints.length === 0) return;
  await client
    .insertQuery()
    .table(DURABLE_TABLES.checkpoints)
    .knexQuery.insert(checkpoints.map(checkpointToRow))
    .onConflict(['run_id', 'seq'])
    .merge();
}

async function updateCheckpointIfPending(
  client: Client,
  checkpoint: StepCheckpoint,
): Promise<boolean> {
  const { run_id: _runId, seq: _seq, ...row } = checkpointToRow(checkpoint);
  const affected = await client
    .from(DURABLE_TABLES.checkpoints)
    .where('run_id', checkpoint.runId)
    .andWhere('seq', checkpoint.seq)
    .andWhere('status', 'pending')
    .update(row);
  return rowsAffected(affected) > 0;
}

/**
 * A case-sensitive "`column` starts with ?" predicate, binding the prefix once. `LIKE` would ignore
 * case on SQLite and on MySQL's default collations (and treat `_` as a wildcard), where the JS
 * `startsWith` this must agree with does not. MySQL compares bytes via `BINARY`.
 */
function prefixSql(dialect: string, column: string, prefix: string): string {
  const head = `substr(${column}, 1, ${prefix.length})`;
  return dialect === 'mysql' ? `binary ${head} = ?` : `${head} = ?`;
}

/** The SQL `CASE` of `checkpointNameKind` over the `name` column. */
function nameKindSql(dialect: string): string {
  const starts = (prefix: string) => {
    const head = `substr(name, 1, ${prefix.length})`;
    return dialect === 'mysql' ? `binary ${head} = '${prefix}'` : `${head} = '${prefix}'`;
  };
  return (
    `case when ${starts('signal:child:')} then 'child' ` +
    `when ${starts('fan:')} then 'folded' ` +
    `when ${starts('spawn:')} then 'spawn' else 'step' end`
  );
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (c) => `!${c}`);
}

function checkpointKey(runId: string, seq: number): string {
  return `${runId}\u0000${seq}`;
}

/**
 * Inside `trx`, the rows among `entries` still `pending`, keyed by {@link checkpointKey}, with
 * `columns` read. Locked on Postgres and MySQL, so a concurrent settle waits; SQLite has no row locks,
 * so the database write lock is taken FIRST with a no-op write, and no other connection or process
 * settles a row between the read and the caller's writes.
 */
async function lockPendingCheckpoints(
  trx: Client,
  entries: Array<{ runId: string; seq: number }>,
  columns: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const first = entries[0];
  if (first && !locksRows(trx)) {
    await trx
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', first.runId)
      .andWhere('seq', first.seq)
      .andWhere('status', 'pending')
      .update({ status: 'pending' });
  }
  const byRun = new Map<string, Set<number>>();
  for (const { runId, seq } of entries) {
    const seqs = byRun.get(runId) ?? new Set<number>();
    seqs.add(seq);
    byRun.set(runId, seqs);
  }
  const pending = new Map<string, Record<string, unknown>>();
  for (const [runId, seqSet] of byRun) {
    const seqs = [...seqSet];
    for (let at = 0; at < seqs.length; at += CHECKPOINT_BATCH) {
      const q = trx
        .from(DURABLE_TABLES.checkpoints)
        .where('run_id', runId)
        .whereIn('seq', seqs.slice(at, at + CHECKPOINT_BATCH))
        .andWhere('status', 'pending')
        .select(...columns);
      if (locksRows(trx)) q.forUpdate();
      for (const row of (await q) as Array<Record<string, unknown>>) {
        pending.set(checkpointKey(runId, Number(row.seq)), row);
      }
    }
  }
  return pending;
}

/** Whether this connection's dialect supports `SELECT … FOR UPDATE` row locks. */
function locksRows(client: Client): boolean {
  const name = client.dialect.name;
  return name === 'postgres' || name === 'mysql';
}

/** Knex `.update()` / `.delete()` return the affected row count as a number across dialects. */
function rowsAffected(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return result.length;
  return 0;
}

/** A `durable_schedules` row as the driver hands it back. */
interface ScheduleRow {
  id: string;
  namespace: string;
  workflow: string;
  paused: boolean | number | string;
  next_fire_at: number | string | null;
  tags: string | null;
  spec: string;
  state: string;
  created_at: number | string;
  updated_at: number | string;
}

function scheduleToRow(r: ScheduleRecord): Record<string, unknown> {
  return {
    id: r.id,
    namespace: normalizeNamespace(r.namespace),
    workflow: r.workflow,
    paused: r.paused,
    next_fire_at: r.nextFireAt,
    tags: r.tags?.length ? JSON.stringify(r.tags) : null,
    spec: JSON.stringify(r.spec),
    state: JSON.stringify(r.state),
    created_at: r.createdAt.getTime(),
    updated_at: r.updatedAt.getTime(),
  };
}

function rowToSchedule(row: ScheduleRow): ScheduleRecord {
  const tags = row.tags
    ? parseJsonColumn<string[]>(row.tags, `${DURABLE_TABLES.schedules}.tags`, row.id)
    : undefined;
  return {
    id: row.id,
    namespace: normalizeNamespace(row.namespace),
    workflow: row.workflow,
    // SQLite/MySQL hand a boolean column back as 0/1 (some drivers as a string).
    paused: row.paused === true || row.paused === 1 || row.paused === '1' || row.paused === 'true',
    nextFireAt: row.next_fire_at == null ? null : Number(row.next_fire_at),
    ...(tags?.length ? { tags } : {}),
    spec:
      parseJsonColumn<Record<string, unknown>>(
        row.spec,
        `${DURABLE_TABLES.schedules}.spec`,
        row.id,
      ) ?? {},
    state:
      parseJsonColumn<Record<string, unknown>>(
        row.state,
        `${DURABLE_TABLES.schedules}.state`,
        row.id,
      ) ?? {},
    createdAt: new Date(Number(row.created_at)),
    updatedAt: new Date(Number(row.updated_at)),
  };
}

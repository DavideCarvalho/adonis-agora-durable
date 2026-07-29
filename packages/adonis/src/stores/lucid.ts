import type { Database } from '@adonisjs/lucid/database';
import type {
  QueryClientContract,
  TransactionClientContract,
} from '@adonisjs/lucid/types/database';
import type {
  AttributeFilter,
  RunQuery,
  RunStatus,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  WorkflowRun,
} from '../interfaces.js';
import {
  attributeColumnFor,
  attributeOperand,
  normalizeAttributeRows,
  sqlComparator,
} from '../search-attributes.js';
import {
  type CheckpointRow,
  type RunRow,
  checkpointToRow,
  rowToCheckpoint,
  rowToRun,
  rowToSignalWaiter,
  runPatchToRow,
  runToRow,
} from './lucid-mappers.js';
import { DURABLE_TABLES, createDurableTables } from './lucid-schema.js';

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

  constructor(db: Database, options: LucidStateStoreOptions = {}) {
    this.db = db;
    this.connectionName = options.connectionName;
  }

  /** The base query client (or a named connection's), used unless an explicit tx client is passed. */
  private client(): QueryClientContract {
    return this.connectionName ? this.db.connection(this.connectionName) : this.db.connection();
  }

  /** Idempotently provision the durable tables (called on boot when `autoSchema` is on). */
  async ensureSchema(): Promise<void> {
    await createDurableTables(this.db, this.connectionName);
  }

  // --- runs ---------------------------------------------------------------

  async createRun(run: WorkflowRun): Promise<void> {
    await this.client().transaction(async (trx) => {
      await trx.table(DURABLE_TABLES.runs).insert(runToRow(run));
      await this.reindexAttributes(trx, run.id, run.searchAttributes);
    });
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const row = runPatchToRow(patch);
    await this.client().transaction(async (trx) => {
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
    const row = runPatchToRow(patch);
    return this.client().transaction(async (trx) => {
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

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const row = await this.client().from(DURABLE_TABLES.runs).where('id', runId).first();
    return row ? rowToRun(row as RunRow) : null;
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

  // --- checkpoints --------------------------------------------------------

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const row = await this.client()
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', runId)
      .andWhere('seq', seq)
      .first();
    return row ? rowToCheckpoint(row as CheckpointRow) : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    await this.upsertCheckpoint(this.client(), checkpoint);
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

  /** Upsert a checkpoint keyed by `(run_id, seq)`, portable across dialects (read-then-write in a tx). */
  private async upsertCheckpoint(client: Client, checkpoint: StepCheckpoint): Promise<void> {
    const row = checkpointToRow(checkpoint);
    const run = () =>
      client.transaction(async (trx) => {
        const existing = await trx
          .from(DURABLE_TABLES.checkpoints)
          .where('run_id', row.run_id)
          .andWhere('seq', row.seq)
          .first();
        if (existing) {
          await trx
            .from(DURABLE_TABLES.checkpoints)
            .where('run_id', row.run_id)
            .andWhere('seq', row.seq)
            .update(row);
        } else {
          await trx.table(DURABLE_TABLES.checkpoints).insert(row);
        }
      });
    // If we're already inside a transaction client, reuse it (Lucid nests via savepoints); otherwise
    // open one on the base client.
    await run();
  }

  // --- recovery / dispatch queries ----------------------------------------

  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    const q = this.client().from(DURABLE_TABLES.runs).where('status', 'running');
    if (namespace !== undefined) q.andWhere('namespace', namespace);
    const rows = await q;
    return (rows as RunRow[]).map(rowToRun);
  }

  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    const q = this.client().from(DURABLE_TABLES.runs).where('status', 'pending');
    if (namespace !== undefined) q.andWhere('namespace', namespace);
    const rows = await q
      .orderBy('created_at', 'asc') // FIFO dispatch
      .orderBy('id', 'asc') // stable tiebreak, mirrors the in-memory store
      .limit(limit);
    return (rows as RunRow[]).map(rowToRun);
  }

  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    const q = this.client()
      .from(DURABLE_TABLES.runs)
      .where('status', 'suspended')
      .whereNotNull('wake_at')
      .andWhere('wake_at', '<=', nowMs);
    if (namespace !== undefined) q.andWhere('namespace', namespace);
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

  async releaseRunLock(runId: string): Promise<void> {
    await this.client()
      .from(DURABLE_TABLES.runs)
      .where('id', runId)
      .update({ locked_by: null, locked_until: null });
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
    await this.client().transaction(async (trx) => {
      const existing = await trx
        .from(DURABLE_TABLES.signalWaiters)
        .where('token', waiter.token)
        .first();
      if (existing) {
        await trx
          .from(DURABLE_TABLES.signalWaiters)
          .where('token', waiter.token)
          .update({
            run_id: waiter.runId,
            seq: waiter.seq,
            parallel_group: waiter.parallelGroup ?? null,
          });
      } else {
        await trx.table(DURABLE_TABLES.signalWaiters).insert({
          token: waiter.token,
          run_id: waiter.runId,
          seq: waiter.seq,
          parallel_group: waiter.parallelGroup ?? null,
        });
      }
    });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    // Atomically take-and-remove: delete by token, returning the row only if WE deleted it. Done in a
    // transaction so a concurrent take can't hand the same waiter to two callers.
    return this.client().transaction(async (trx) => {
      const row = await trx.from(DURABLE_TABLES.signalWaiters).where('token', token).first();
      if (!row) return null;
      const deleted = await trx.from(DURABLE_TABLES.signalWaiters).where('token', token).delete();
      if (rowsAffected(deleted) !== 1) return null;
      return rowToSignalWaiter(
        row as { token: string; run_id: string; seq: number | string; parallel_group?: unknown },
      );
    });
  }

  async listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    const rows = await this.client()
      .from(DURABLE_TABLES.signalWaiters)
      .where('token', 'like', `${prefix}%`);
    return (
      rows as Array<{
        token: string;
        run_id: string;
        seq: number | string;
        parallel_group?: unknown;
      }>
    ).map(rowToSignalWaiter);
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

  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    return this.client().transaction(async (trx) => {
      const row = await trx
        .from(DURABLE_TABLES.bufferedSignals)
        .where('token', token)
        .orderBy('id', 'asc')
        .first();
      if (!row) return null;
      const r = row as { id: number | string; payload: string | null };
      const deleted = await trx.from(DURABLE_TABLES.bufferedSignals).where('id', r.id).delete();
      if (rowsAffected(deleted) !== 1) return null;
      return { payload: r.payload == null ? undefined : (JSON.parse(r.payload) as unknown) };
    });
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
      payload: r.payload == null ? undefined : (JSON.parse(r.payload) as unknown),
      publishedAt: Number(r.published_at),
    }));
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
        saveCheckpoint: async (cp) => {
          const row = checkpointToRow(cp);
          const existing = await trx
            .from(DURABLE_TABLES.checkpoints)
            .where('run_id', row.run_id)
            .andWhere('seq', row.seq)
            .first();
          if (existing) {
            await trx
              .from(DURABLE_TABLES.checkpoints)
              .where('run_id', row.run_id)
              .andWhere('seq', row.seq)
              .update(row);
          } else {
            await trx.table(DURABLE_TABLES.checkpoints).insert(row);
          }
        },
      }),
    );
  }

  // --- dashboard queries --------------------------------------------------

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    const q = this.client().from(DURABLE_TABLES.runs);

    if (query.workflow) q.where('workflow', query.workflow);
    if (query.namespace !== undefined) q.where('namespace', query.namespace);
    if (query.status) q.where('status', query.status);
    if (query.statuses) {
      // `status IN (...)`; an empty set matches nothing (mirrors the in-memory store).
      if (query.statuses.length) q.whereIn('status', query.statuses);
      else q.whereRaw('1 = 0');
    }
    // `tags` is stored as a JSON array string; match the quoted token so `etl` doesn't match `etl-foo`.
    if (query.tag) q.where('tags', 'like', `%"${query.tag}"%`);

    // Typed/range attribute predicates push DOWN into SQL via one EXISTS per filter against the
    // normalized side-table — so the DB filters AND paginates, no full scan + in-process filter.
    if (query.attributes?.length) {
      for (const f of query.attributes) this.applyAttributeExists(q, f);
    }

    q.orderBy('created_at', 'desc'); // newest first — recent runs on top in the dashboard
    if (query.limit !== undefined) q.limit(query.limit);
    if (query.offset !== undefined) q.offset(query.offset);

    const rows = await q;
    return (rows as RunRow[]).map(rowToRun);
  }

  /**
   * Add one attribute predicate as a correlated EXISTS subquery on the side-table. `<>` (ne) also
   * excludes runs where the attribute is absent (the missing-key-never-matches contract): EXISTS
   * already requires the key row present, so EXISTS(... <> ...) is exactly ne-with-present. Numeric
   * operands compare `num_value`, everything else `str_value`.
   */
  private applyAttributeExists(q: AnyQuery, f: AttributeFilter): void {
    const col = attributeColumnFor(f) === 'numValue' ? 'num_value' : 'str_value';
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
        for (const p of prefixes) q.orWhere('name', 'like', `${p}%`);
      })
      .orderBy('seq', 'asc');
    return (rows as CheckpointRow[]).map(rowToCheckpoint);
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

/** Knex `.update()` / `.delete()` return the affected row count as a number across dialects. */
function rowsAffected(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return result.length;
  return 0;
}

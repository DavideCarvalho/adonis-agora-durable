import type {
  BufferedSignalRow,
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
} from './interfaces.js';
import { scanRunValueFacets } from './run-value-facets.js';

/**
 * Transforms a payload value as it crosses the store boundary — e.g. encrypt-at-rest, compress, or
 * redact PII. `decode` must be the exact inverse of `encode`. Both are synchronous (use a local
 * cipher / codec); wrap an async KMS yourself if you need one.
 */
export interface PayloadCodec {
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
}

/** What {@link CodecStateStore} runs through the codec. */
export interface CodecStateStoreOptions {
  /**
   * `'payloads'` (default, the historical behavior): run/step `input` + `output` only. **Know what
   * that leaves in the clear**: step `events` (everything step code passes to `ctx.log`), the
   * structured `error` messages, heartbeat progress, and search attributes — a deployment sold as
   * "encrypted payloads" still leaks whatever its steps log.
   *
   * `'extended'`: also encode step `events`, step/run `error`, and heartbeat progress (search
   * attributes stay clear — they must remain queryable). ONLY enable on a FRESH table, or with a
   * codec whose `decode` recognizes its own ciphertext and passes other values through: rows
   * written before the switch hold those fields as plaintext, and a decode that can't tell would
   * garble them.
   */
  coverage?: 'payloads' | 'extended';
}

/**
 * A `StateStore` decorator that runs run/step **payloads** through a {@link PayloadCodec} — encoded
 * on write, decoded on read — so they're never stored in the clear. Adapter-agnostic: wrap any
 * store. Searchable metadata (id, status, workflow, tags, timestamps) is left untouched so the
 * dashboard, queries, and recovery still work. See {@link CodecStateStoreOptions.coverage} for
 * exactly which fields are covered — the default covers `input`/`output` only.
 *
 * ```ts
 * const store = new CodecStateStore(new TypeOrmStateStore(ds), aesCodec, { coverage: 'extended' });
 * ```
 */
export class CodecStateStore implements StateStore {
  private readonly extended: boolean;

  /** Schedules persist their run `input` inside `spec` — encoded like any other payload. Bound only
   *  when the inner store persists schedules, so `engine.schedules` reports absence faithfully. */
  readonly saveSchedule?: (record: ScheduleRecord) => Promise<void>;
  readonly getSchedule?: (id: string) => Promise<ScheduleRecord | null>;
  readonly updateSchedule?: (
    id: string,
    patch: Partial<Omit<ScheduleRecord, 'id' | 'createdAt'>>,
    expectedNextFireAt?: number | null,
  ) => Promise<boolean>;
  readonly deleteSchedule?: (id: string) => Promise<boolean>;
  readonly listSchedules?: (query: ScheduleQuery) => Promise<ScheduleRecord[]>;

  /** The placeholder checkpoints are encoded like any other checkpoint. The four methods below are
   *  bound only when the inner store has them: their absence is what turns the engine's barrier,
   *  batching and folding off, so the wrapper must not fake them. */
  readonly registerChildWaits?: (entries: ChildWait[]) => Promise<void>;
  /** The folded checkpoint carries the children's outputs, so it is encoded. */
  readonly compactCheckpoints?: (
    runId: string,
    fromSeq: number,
    toSeq: number,
    into: StepCheckpoint,
  ) => Promise<void>;
  /** Forwarded verbatim — a waiter carries no payload. */
  readonly hasSignalWaiter?: (runId: string, tokenPrefix: string) => Promise<boolean>;
  /** Encodes like {@link saveCheckpoint}. Bound only when the inner store has it, so the engine's
   *  plain-save fallback still kicks in through the wrapper. */
  readonly saveCheckpointIfPending?: (checkpoint: StepCheckpoint) => Promise<boolean>;
  /** Forwarded verbatim — a lease carries no payload. Bound only when the inner store has it. */
  readonly releaseRunLockUnlessWakeRequested?: (runId: string, owner: string) => Promise<boolean>;
  /** Encodes each checkpoint like {@link saveCheckpoint}. Bound only when the inner store has it. */
  readonly saveCheckpointsIfPending?: (checkpoints: StepCheckpoint[]) => Promise<boolean[]>;
  /** Forwarded verbatim — a lease deadline carries no payload. Bound only when the inner store has
   *  it, so the engine's {@link saveCheckpointIfPending} fallback still applies through the wrapper. */
  readonly renewCheckpointLease?: (
    runId: string,
    seq: number,
    expectedWakeAt: number | undefined,
    wakeAt: number,
  ) => Promise<boolean>;
  /** Encodes each settlement's `output` (and `events`/`error` under `extended` coverage) like
   *  {@link saveCheckpoint}. Bound only when the inner store has it. */
  readonly settleCheckpointsIfPending?: (settlements: StepSettlement[]) => Promise<boolean[]>;
  /** Forwarded verbatim — a timer carries no payload. Bound only when the inner store has it, so the
   *  engine's {@link updateRunIf} fallback still applies through the wrapper. */
  readonly pullRunWakesIn?: (runIds: string[], wakeAt: number) => Promise<void>;
  /** Decodes each checkpoint read like {@link listCheckpoints}. Bound only when the inner store has
   *  it. */
  readonly listCheckpointsForReplay?: (runId: string) => Promise<StepCheckpoint[]>;
  /** Forwarded verbatim — deletes read no payload. Bound only when the inner store has it, so the
   *  engine's one-`deleteRun`-per-id fallback still applies through the wrapper. */
  readonly deleteRuns?: (runIds: string[]) => Promise<void>;
  /** Decodes each run like {@link getRun}. Bound only when the inner store has it. */
  readonly getRuns?: (runIds: string[]) => Promise<WorkflowRun[]>;
  /** Forwarded verbatim — a `GROUP BY` reads no payload. Bound only when the inner store has it. */
  readonly runFacets?: (query: RunFacetQuery) => Promise<RunFacetRow[]>;
  /** Forwarded verbatim — the buckets aggregate names, statuses and timestamps, never a payload.
   *  Bound only when the inner store aggregates, so the run detail's fallback still applies. */
  readonly checkpointStats?: (
    runId: string,
    opts?: { group?: string | undefined },
  ) => Promise<CheckpointStat[]>;
  /** Filters on unencoded columns, then decodes the rows like {@link listCheckpoints}. Bound only
   *  when the inner store has it. */
  readonly queryCheckpoints?: (runId: string, query: CheckpointQuery) => Promise<StepCheckpoint[]>;
  /** Forwarded verbatim. Bound only when the inner store has it. */
  readonly pruneBufferedEvents?: (publishedBefore: number, limit: number) => Promise<number>;
  /** The same codec over the inner store's scoped view. Bound only when the inner store scopes. */
  readonly withScope?: (scope: { namespace?: string | undefined }) => CodecStateStore;
  /** Forwarded verbatim — an admission claim touches only status/tags, never a payload. Bound only
   *  when the inner store has it, so singleton workflows keep failing fast on a store without it. */
  readonly tryAdmitSingleton?: (
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ) => Promise<boolean>;
  /** Forwarded verbatim — reads tokens, never a payload. Bound only when the inner store has it. */
  readonly listBufferedSignalTokens?: (prefix: string, limit: number) => Promise<string[]>;
  /** Decodes each payload. Bound only when the inner store has it. */
  readonly listBufferedSignals?: (
    tokenPrefix: string,
    afterId: string | undefined,
    limit: number,
  ) => Promise<BufferedSignalRow[]>;
  /** Forwarded verbatim. Bound only when the inner store has it. */
  readonly deleteBufferedSignals?: (ids: string[]) => Promise<void>;
  /** Forwarded verbatim — a count reads no payload. Bound only when the inner store has it. */
  readonly countCheckpoints?: (
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ) => Promise<number>;
  /** Forwarded verbatim — reads no payload. Bound only when the inner store has it. */
  readonly hasCheckpoints?: (
    runId: string,
    fromSeq: number,
    toSeq: number,
    statuses: StepCheckpoint['status'][],
  ) => Promise<boolean>;
  /** Decodes each checkpoint. Bound only when the inner store has it. */
  readonly getCheckpoints?: (runId: string, seqs: number[]) => Promise<StepCheckpoint[]>;
  /** Decodes each checkpoint. Bound only when the inner store has it. */
  readonly getCheckpointsForSettle?: (runId: string, seqs: number[]) => Promise<StepCheckpoint[]>;
  /** Encodes each checkpoint. Bound only when the inner store has it. */
  readonly saveCheckpoints?: (checkpoints: StepCheckpoint[]) => Promise<void>;

  constructor(
    private readonly inner: StateStore,
    private readonly codec: PayloadCodec,
    options: CodecStateStoreOptions = {},
  ) {
    this.extended = options.coverage === 'extended';
    const getMany = inner.getCheckpoints;
    if (getMany) {
      this.getCheckpoints = async (runId, seqs) =>
        (await getMany.call(inner, runId, seqs)).map((cp) => this.decCp(cp) as StepCheckpoint);
    }
    const getForSettle = inner.getCheckpointsForSettle;
    if (getForSettle) {
      this.getCheckpointsForSettle = async (runId, seqs) =>
        (await getForSettle.call(inner, runId, seqs)).map((cp) => this.decCp(cp) as StepCheckpoint);
    }
    const saveMany = inner.saveCheckpoints;
    if (saveMany) {
      this.saveCheckpoints = (cps) =>
        saveMany.call(
          inner,
          cps.map((cp) => this.encCp(cp)),
        );
    }
    const releaseUnlessWake = inner.releaseRunLockUnlessWakeRequested;
    if (releaseUnlessWake) {
      this.releaseRunLockUnlessWakeRequested = (runId, owner) =>
        releaseUnlessWake.call(inner, runId, owner);
    }
    const saveIfPending = inner.saveCheckpointIfPending;
    if (saveIfPending) {
      this.saveCheckpointIfPending = (cp) => saveIfPending.call(inner, this.encCp(cp));
    }
    const saveManyIfPending = inner.saveCheckpointsIfPending;
    if (saveManyIfPending) {
      this.saveCheckpointsIfPending = (cps) =>
        saveManyIfPending.call(
          inner,
          cps.map((cp) => this.encCp(cp)),
        );
    }
    const renewLease = inner.renewCheckpointLease;
    if (renewLease) {
      this.renewCheckpointLease = (runId, seq, expectedWakeAt, wakeAt) =>
        renewLease.call(inner, runId, seq, expectedWakeAt, wakeAt);
    }
    const settleIfPending = inner.settleCheckpointsIfPending;
    if (settleIfPending) {
      this.settleCheckpointsIfPending = (settlements) =>
        settleIfPending.call(
          inner,
          settlements.map((s) => this.encSettlement(s)),
        );
    }
    const pullWakesIn = inner.pullRunWakesIn;
    if (pullWakesIn) {
      this.pullRunWakesIn = (runIds, wakeAt) => pullWakesIn.call(inner, runIds, wakeAt);
    }
    const listForReplay = inner.listCheckpointsForReplay;
    if (listForReplay) {
      this.listCheckpointsForReplay = async (runId) =>
        (await listForReplay.call(inner, runId)).map((cp) => this.decCp(cp));
    }
    const getRuns = inner.getRuns;
    if (getRuns)
      this.getRuns = async (ids) => (await getRuns.call(inner, ids)).map((r) => this.decRun(r));
    const deleteRuns = inner.deleteRuns;
    if (deleteRuns) this.deleteRuns = (ids) => deleteRuns.call(inner, ids);
    const runFacets = inner.runFacets;
    if (runFacets) this.runFacets = (query) => runFacets.call(inner, query);
    const stats = inner.checkpointStats;
    const queryCps = inner.queryCheckpoints;
    if (stats && queryCps) {
      this.checkpointStats = (runId, opts) => stats.call(inner, runId, opts);
      this.queryCheckpoints = async (runId, query) =>
        (await queryCps.call(inner, runId, query)).map((c) => this.decCp(c));
    }
    const prune = inner.pruneBufferedEvents;
    if (prune) this.pruneBufferedEvents = (before, limit) => prune.call(inner, before, limit);
    const scoped = (inner as StateStore & { withScope?: unknown }).withScope;
    if (typeof scoped === 'function') {
      this.withScope = (scope) =>
        new CodecStateStore(
          (scoped as (s: { namespace?: string | undefined }) => StateStore).call(inner, scope),
          codec,
          options,
        );
    }
    const tryAdmitSingleton = inner.tryAdmitSingleton;
    if (tryAdmitSingleton) {
      this.tryAdmitSingleton = (runId, tag, workflow, limit, retryWakeAt) =>
        tryAdmitSingleton.call(inner, runId, tag, workflow, limit, retryWakeAt);
    }
    const listSignals = inner.listBufferedSignals;
    if (listSignals) {
      this.listBufferedSignals = async (prefix, afterId, limit) =>
        (await listSignals.call(inner, prefix, afterId, limit)).map((row) => ({
          ...row,
          payload: this.dec(row.payload),
        }));
    }
    const deleteSignals = inner.deleteBufferedSignals;
    if (deleteSignals) this.deleteBufferedSignals = (ids) => deleteSignals.call(inner, ids);
    const listTokens = inner.listBufferedSignalTokens;
    if (listTokens) {
      this.listBufferedSignalTokens = (prefix, limit) => listTokens.call(inner, prefix, limit);
    }
    const countCheckpoints = inner.countCheckpoints;
    if (countCheckpoints) {
      this.countCheckpoints = (runId, fromSeq, toSeq, statuses) =>
        countCheckpoints.call(inner, runId, fromSeq, toSeq, statuses);
    }
    const hasCheckpoints = inner.hasCheckpoints;
    if (hasCheckpoints) {
      this.hasCheckpoints = (runId, fromSeq, toSeq, statuses) =>
        hasCheckpoints.call(inner, runId, fromSeq, toSeq, statuses);
    }
    const registerChildWaits = inner.registerChildWaits;
    if (registerChildWaits) {
      this.registerChildWaits = (entries) =>
        registerChildWaits.call(
          inner,
          entries.map((e) => ({ waiter: e.waiter, checkpoint: this.encCp(e.checkpoint) })),
        );
    }
    const compact = inner.compactCheckpoints;
    if (compact) {
      this.compactCheckpoints = (runId, fromSeq, toSeq, into) =>
        compact.call(inner, runId, fromSeq, toSeq, this.encCp(into));
    }
    const hasWaiter = inner.hasSignalWaiter;
    if (hasWaiter) {
      this.hasSignalWaiter = (runId, tokenPrefix) => hasWaiter.call(inner, runId, tokenPrefix);
    }
    const { saveSchedule, getSchedule, updateSchedule, deleteSchedule, listSchedules } = inner;
    if (saveSchedule && getSchedule && updateSchedule && deleteSchedule && listSchedules) {
      this.saveSchedule = (r) => saveSchedule.call(inner, this.encSchedule(r));
      this.getSchedule = async (id) => this.decSchedule(await getSchedule.call(inner, id));
      this.updateSchedule = (id, patch, expected) =>
        updateSchedule.call(
          inner,
          id,
          patch.spec ? { ...patch, spec: this.encSpec(patch.spec) } : patch,
          expected,
        );
      this.deleteSchedule = (id) => deleteSchedule.call(inner, id);
      this.listSchedules = async (q) =>
        (await listSchedules.call(inner, q)).map((r) => this.decSchedule(r) as ScheduleRecord);
    }
  }

  private encSpec(spec: Record<string, unknown>): Record<string, unknown> {
    return 'input' in spec ? { ...spec, input: this.enc(spec.input) } : spec;
  }
  private encSchedule(r: ScheduleRecord): ScheduleRecord {
    return { ...r, spec: this.encSpec(r.spec) };
  }
  private decSchedule(r: ScheduleRecord | null): ScheduleRecord | null {
    if (!r || !('input' in r.spec)) return r;
    return { ...r, spec: { ...r.spec, input: this.dec(r.spec.input) } };
  }

  private enc(v: unknown): unknown {
    return v === undefined ? undefined : this.codec.encode(v);
  }
  private dec(v: unknown): unknown {
    return v === undefined ? undefined : this.codec.decode(v);
  }

  private encRun(run: WorkflowRun): WorkflowRun {
    const next: WorkflowRun = { ...run, input: this.enc(run.input), output: this.enc(run.output) };
    if (this.extended && run.error !== undefined) {
      next.error = this.enc(run.error) as WorkflowRun['error'];
    }
    return next;
  }
  private decRun<T extends WorkflowRun | null>(run: T): T {
    if (!run) return run;
    const next: WorkflowRun = { ...run, input: this.dec(run.input), output: this.dec(run.output) };
    if (this.extended && run.error !== undefined) {
      next.error = this.dec(run.error) as WorkflowRun['error'];
    }
    return next as T;
  }
  private encCp(cp: StepCheckpoint): StepCheckpoint {
    const next: StepCheckpoint = { ...cp, input: this.enc(cp.input), output: this.enc(cp.output) };
    if (this.extended) {
      if (cp.events !== undefined) next.events = this.enc(cp.events) as StepCheckpoint['events'];
      if (cp.error !== undefined) next.error = this.enc(cp.error) as StepCheckpoint['error'];
      if (cp.heartbeatProgress !== undefined) {
        next.heartbeatProgress = this.enc(cp.heartbeatProgress);
      }
    }
    return next;
  }
  private encSettlement(settlement: StepSettlement): StepSettlement {
    const next: StepSettlement = { ...settlement, output: this.enc(settlement.output) };
    if (this.extended) {
      if (settlement.events !== undefined) {
        next.events = this.enc(settlement.events) as StepSettlement['events'];
      }
      if (settlement.error !== undefined) {
        next.error = this.enc(settlement.error) as StepSettlement['error'];
      }
    }
    return next;
  }
  private decCp<T extends StepCheckpoint | null>(cp: T): T {
    if (!cp) return cp;
    const next: StepCheckpoint = { ...cp, input: this.dec(cp.input), output: this.dec(cp.output) };
    if (this.extended) {
      if (cp.events !== undefined) next.events = this.dec(cp.events) as StepCheckpoint['events'];
      if (cp.error !== undefined) next.error = this.dec(cp.error) as StepCheckpoint['error'];
      if (cp.heartbeatProgress !== undefined) {
        next.heartbeatProgress = this.dec(cp.heartbeatProgress);
      }
    }
    return next as T;
  }

  ensureSchema(): Promise<void> {
    return this.inner.ensureSchema?.() ?? Promise.resolve();
  }

  createRun(run: WorkflowRun): Promise<void> {
    return this.inner.createRun(this.encRun(run));
  }
  updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const next = { ...patch };
    if ('input' in patch) next.input = this.enc(patch.input);
    if ('output' in patch) next.output = this.enc(patch.output);
    return this.inner.updateRun(runId, next);
  }
  updateRunIf(
    runId: string,
    expectedStatuses: RunStatus[],
    patch: Partial<WorkflowRun>,
  ): Promise<boolean> {
    const next = { ...patch };
    if ('input' in patch) next.input = this.enc(patch.input);
    if ('output' in patch) next.output = this.enc(patch.output);
    return this.inner.updateRunIf(runId, expectedStatuses, next);
  }
  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.decRun(await this.inner.getRun(runId));
  }
  deleteRun(runId: string): Promise<void> {
    return this.inner.deleteRun(runId);
  }
  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    return this.decCp(await this.inner.getCheckpoint(runId, seq));
  }
  saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    return this.inner.saveCheckpoint(this.encCp(checkpoint));
  }
  /**
   * Forwarded — previously this wrapper simply didn't implement the optional method, so wrapping a
   * store with a codec silently DISABLED persisted step liveness entirely. Under `extended`
   * coverage the progress payload is encoded like every other step payload.
   */
  recordStepHeartbeat(runId: string, seq: number, at: Date, progress?: unknown): Promise<void> {
    if (!this.inner.recordStepHeartbeat) return Promise.resolve();
    const encoded = this.extended && progress !== undefined ? this.enc(progress) : progress;
    return this.inner.recordStepHeartbeat(runId, seq, at, encoded);
  }
  transaction<T>(
    work: (tx: {
      raw: unknown;
      saveCheckpoint: (cp: StepCheckpoint) => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    if (!this.inner.transaction) {
      throw new Error('the wrapped store does not support transactions');
    }
    // Encode the checkpoint inside the tx, so payloads stay encoded at rest like the normal path.
    return this.inner.transaction((tx) =>
      work({ raw: tx.raw, saveCheckpoint: (cp) => tx.saveCheckpoint(this.encCp(cp)) }),
    );
  }
  async listIncompleteRuns(namespace?: string): Promise<WorkflowRun[]> {
    return (await this.inner.listIncompleteRuns(namespace)).map((r) => this.decRun(r));
  }
  async listPendingRuns(limit: number, namespace?: string): Promise<WorkflowRun[]> {
    return (await this.inner.listPendingRuns(limit, namespace)).map((r) => this.decRun(r));
  }
  async listDueTimers(nowMs: number, namespace?: string, limit?: number): Promise<WorkflowRun[]> {
    return (await this.inner.listDueTimers(nowMs, namespace, limit)).map((r) => this.decRun(r));
  }
  async listOrphanedRuns(
    nowMs: number,
    limit: number,
    namespace?: string,
    owner?: string,
  ): Promise<WorkflowRun[]> {
    // Forward when the inner store implements it; otherwise mirror the engine's own fallback
    // (filter listIncompleteRuns in-process) so wrapping never REMOVES the optimized path's shape.
    if (this.inner.listOrphanedRuns) {
      const orphans =
        owner === undefined
          ? await this.inner.listOrphanedRuns(nowMs, limit, namespace)
          : await this.inner.listOrphanedRuns(nowMs, limit, namespace, owner);
      return orphans.map((r) => this.decRun(r));
    }
    return (await this.inner.listIncompleteRuns(namespace))
      .filter(
        (r) =>
          r.lockedUntil === undefined ||
          r.lockedUntil <= nowMs ||
          (owner !== undefined && r.lockedBy === owner),
      )
      .slice(0, limit)
      .map((r) => this.decRun(r));
  }
  tryLockRun(runId: string, owner: string, leaseUntilMs: number, nowMs: number): Promise<boolean> {
    return this.inner.tryLockRun(runId, owner, leaseUntilMs, nowMs);
  }
  releaseRunLock(runId: string, owner?: string): Promise<void> {
    return this.inner.releaseRunLock(runId, owner);
  }
  renewRunLock(runId: string, owner: string, leaseUntilMs: number): Promise<boolean> {
    return this.inner.renewRunLock(runId, owner, leaseUntilMs);
  }
  putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    return this.inner.putSignalWaiter(waiter);
  }
  takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    return this.inner.takeSignalWaiter(token);
  }
  listSignalWaiters(prefix: string): Promise<SignalWaiter[]> {
    return this.inner.listSignalWaiters(prefix);
  }
  listSignalWaitersByRunIds(runIds: string[]): Promise<SignalWaiter[]> {
    if (this.inner.listSignalWaitersByRunIds) {
      return this.inner.listSignalWaitersByRunIds(runIds);
    }
    // Fallback scan keeps the optional method PRESENT on the wrapper without requiring it inner.
    const ids = new Set(runIds);
    return this.inner.listSignalWaiters('').then((ws) => ws.filter((w) => ids.has(w.runId)));
  }
  removeSignalWaiter(waiter: SignalWaiter): Promise<void> {
    return this.inner.removeSignalWaiter(waiter);
  }
  bufferSignal(token: string, payload: unknown): Promise<void> {
    return this.inner.bufferSignal(token, this.enc(payload));
  }
  async takeBufferedSignal(token: string): Promise<{ payload: unknown } | null> {
    const buffered = await this.inner.takeBufferedSignal(token);
    return buffered && { payload: this.dec(buffered.payload) };
  }
  bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    return this.inner.bufferEvent({ ...input, payload: this.enc(input.payload) });
  }
  async listBufferedEvents(
    name: string,
    limit: number,
  ): Promise<Array<{ id: string; payload: unknown; publishedAt: number }>> {
    const events = await this.inner.listBufferedEvents(name, limit);
    return events.map((e) => ({ ...e, payload: this.dec(e.payload) }));
  }
  removeBufferedEvent(id: string): Promise<boolean> {
    return this.inner.removeBufferedEvent(id);
  }
  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return (await this.inner.listRuns(query)).map((r) => this.decRun(r));
  }
  /** Forwarded when the inner store counts (a count reads no payload); else counts a listing. */
  async countRuns(query: Omit<RunQuery, 'page' | 'size'>): Promise<number> {
    if (this.inner.countRuns) return this.inner.countRuns(query);
    return (await this.inner.listRuns(query)).length;
  }
  async runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    // Forward when the inner store implements it; otherwise count a bounded scan in-process. Facet
    // rows carry no encrypted payload (values are workflow names, tags, attribute keys/values as
    // stored), so no decrypt pass is needed either way.
    if (this.inner.runValueFacets) {
      return this.inner.runValueFacets(axis, query, opts);
    }
    return scanRunValueFacets(this, axis, query, opts);
  }
  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    return (await this.inner.listCheckpoints(runId)).map((c) => this.decCp(c));
  }
  async getLatestCheckpointByName(
    runId: string,
    name: string,
  ): Promise<StepCheckpoint | undefined> {
    // Forward the targeted read when the inner store implements it; otherwise fall back to the
    // (always-present) listCheckpoints scan so wrapping a legacy custom store keeps working.
    if (this.inner.getLatestCheckpointByName) {
      const cp = await this.inner.getLatestCheckpointByName(runId, name);
      return cp ? this.decCp(cp) : undefined;
    }
    let latest: StepCheckpoint | undefined;
    for (const cp of await this.inner.listCheckpoints(runId)) if (cp.name === name) latest = cp;
    return latest ? this.decCp(latest) : undefined;
  }
  async listCheckpointsByNamePrefix(runId: string, prefixes: string[]): Promise<StepCheckpoint[]> {
    const matches = this.inner.listCheckpointsByNamePrefix
      ? await this.inner.listCheckpointsByNamePrefix(runId, prefixes)
      : (await this.inner.listCheckpoints(runId)).filter((cp) =>
          prefixes.some((p) => cp.name.startsWith(p)),
        );
    return matches.map((c) => this.decCp(c));
  }
}

import type {
  RunQuery,
  RunStatus,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  WorkflowRun,
} from './interfaces.js';

/**
 * Transforms a payload value as it crosses the store boundary — e.g. encrypt-at-rest, compress, or
 * redact PII. `decode` must be the exact inverse of `encode`. Both are synchronous (use a local
 * cipher / codec); wrap an async KMS yourself if you need one.
 */
export interface PayloadCodec {
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
}

/**
 * A `StateStore` decorator that runs run/step **payloads** (input + output) through a
 * {@link PayloadCodec} — encoded on write, decoded on read — so they're never stored in the clear.
 * Adapter-agnostic: wrap any store. Searchable metadata (id, status, workflow, tags, timestamps) and
 * the structured `error` are left untouched so the dashboard, queries, and recovery still work.
 *
 * ```ts
 * const store = new CodecStateStore(new TypeOrmStateStore(ds), aesCodec);
 * ```
 */
export class CodecStateStore implements StateStore {
  constructor(
    private readonly inner: StateStore,
    private readonly codec: PayloadCodec,
  ) {}

  private enc(v: unknown): unknown {
    return v === undefined ? undefined : this.codec.encode(v);
  }
  private dec(v: unknown): unknown {
    return v === undefined ? undefined : this.codec.decode(v);
  }

  private encRun(run: WorkflowRun): WorkflowRun {
    return { ...run, input: this.enc(run.input), output: this.enc(run.output) };
  }
  private decRun<T extends WorkflowRun | null>(run: T): T {
    return (run && { ...run, input: this.dec(run.input), output: this.dec(run.output) }) as T;
  }
  private encCp(cp: StepCheckpoint): StepCheckpoint {
    return { ...cp, input: this.enc(cp.input), output: this.enc(cp.output) };
  }
  private decCp<T extends StepCheckpoint | null>(cp: T): T {
    return (cp && { ...cp, input: this.dec(cp.input), output: this.dec(cp.output) }) as T;
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
  async listDueTimers(nowMs: number, namespace?: string): Promise<WorkflowRun[]> {
    return (await this.inner.listDueTimers(nowMs, namespace)).map((r) => this.decRun(r));
  }
  tryLockRun(runId: string, owner: string, leaseUntilMs: number, nowMs: number): Promise<boolean> {
    return this.inner.tryLockRun(runId, owner, leaseUntilMs, nowMs);
  }
  releaseRunLock(runId: string): Promise<void> {
    return this.inner.releaseRunLock(runId);
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

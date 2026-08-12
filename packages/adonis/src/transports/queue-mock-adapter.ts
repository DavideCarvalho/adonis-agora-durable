import type { AcquiredJob, Adapter, JobData } from '@adonisjs/queue/types';

/**
 * A tiny in-memory `@adonisjs/queue` adapter for tests — implements just the surface the
 * `QueueTransport` touches (push/pop/complete/fail/retry/recoverStalledJobs/destroy) as plain FIFO
 * queues, plus throwing stubs for the rest of the contract. No Redis, no Knex. `popFrom` mimics the
 * real adapters' atomic move (pending → active) so two transports sharing one instance never
 * double-consume, and the delayed → pending promotion a `retryJob(…, retryAt)` relies on.
 */
export class MockAdapter implements Adapter {
  readonly pending = new Map<string, JobData[]>();
  readonly active = new Map<string, AcquiredJob>();
  /** Which queue each active job was popped from — the real adapters key `active` per queue, but this
   *  mock keys it by job id, so `recoverStalledJobs(queue, …)` needs this to scope a sweep to one queue. */
  readonly activeQueue = new Map<string, string>();
  /** Jobs awaiting their `readyAt`, per queue — promoted into `pending` by `popFrom`, as the real
   *  adapters' acquire script does. Keyed the same way so a delayed retry isn't lost. */
  readonly delayed = new Map<string, { job: JobData; readyAt: number }[]>();
  workerId = '';
  destroyed = false;

  setWorkerId(id: string): void {
    this.workerId = id;
  }

  async pushOn(queue: string, jobData: JobData): Promise<void> {
    const list = this.pending.get(queue) ?? [];
    list.push(jobData);
    this.pending.set(queue, list);
  }

  async push(jobData: JobData): Promise<void> {
    await this.pushOn('default', jobData);
  }

  async popFrom(queue: string): Promise<AcquiredJob | null> {
    this.#promoteDelayed(queue);
    const list = this.pending.get(queue);
    if (!list || list.length === 0) return null;
    // Mirror the real adapters' priority ordering: lower `priority` number runs first (default 5 when
    // absent), FIFO among equal priorities. A plain FIFO queue (no priorities set) is unchanged.
    const DEFAULT_PRIORITY = 5;
    let bestIndex = 0;
    let bestPriority = list[0]?.priority ?? DEFAULT_PRIORITY;
    for (let i = 1; i < list.length; i += 1) {
      const candidate = list[i]?.priority ?? DEFAULT_PRIORITY;
      if (candidate < bestPriority) {
        bestIndex = i;
        bestPriority = candidate;
      }
    }
    const [job] = list.splice(bestIndex, 1);
    if (!job) return null;
    const acquired: AcquiredJob = { ...job, acquiredAt: Date.now() };
    this.active.set(job.id, acquired);
    this.activeQueue.set(job.id, queue);
    return acquired;
  }

  async pop(): Promise<AcquiredJob | null> {
    return this.popFrom('default');
  }

  async completeJob(jobId: string): Promise<void> {
    this.active.delete(jobId);
    this.activeQueue.delete(jobId);
  }

  async failJob(jobId: string): Promise<void> {
    this.active.delete(jobId);
    this.activeQueue.delete(jobId);
  }

  /**
   * Move an active job back for redelivery, counting the attempt — `retryAt` in the future parks it
   * in `delayed` until `popFrom` promotes it, exactly as the real adapters' retry script does. A job
   * that is no longer active (already completed) is a no-op.
   */
  async retryJob(jobId: string, queue: string, retryAt?: Date): Promise<void> {
    const job = this.active.get(jobId);
    if (!job) return;
    this.active.delete(jobId);
    this.activeQueue.delete(jobId);
    const { acquiredAt: _acquiredAt, ...data } = job;
    const next: JobData = { ...data, attempts: (data.attempts ?? 0) + 1 };
    const readyAt = retryAt?.getTime() ?? 0;
    if (readyAt > Date.now()) {
      const waiting = this.delayed.get(queue) ?? [];
      waiting.push({ job: next, readyAt });
      this.delayed.set(queue, waiting);
      return;
    }
    await this.pushOn(queue, next);
  }

  /**
   * Reclaim jobs of `queue` whose claim is older than `stalledThreshold` (the crashed-worker signal):
   * move each back to `pending` with an incremented `stalledCount`, exactly as the real adapters' Lua/SQL
   * does. A claim younger than the threshold is left active (a slow-but-alive worker). A job whose next
   * `stalledCount` would exceed `maxStalledCount` is failed permanently (dropped) instead of re-delivered.
   * Returns the number of jobs re-delivered (not the permanently failed ones).
   */
  async recoverStalledJobs(
    queue: string,
    stalledThreshold: number,
    maxStalledCount: number,
  ): Promise<number> {
    const cutoff = Date.now() - stalledThreshold;
    let recovered = 0;
    for (const [id, job] of this.active) {
      if (this.activeQueue.get(id) !== queue) continue;
      if (job.acquiredAt >= cutoff) continue; // fresh claim — not stalled
      this.active.delete(id);
      this.activeQueue.delete(id);
      const { acquiredAt: _acquiredAt, ...data } = job;
      const stalledCount = (data.stalledCount ?? 0) + 1;
      if (stalledCount > maxStalledCount) continue; // exceeded the bound → failed permanently
      await this.pushOn(queue, { ...data, stalledCount });
      recovered += 1;
    }
    return recovered;
  }

  /** Promote every delayed job of `queue` whose `readyAt` has passed into `pending` (see popFrom). */
  #promoteDelayed(queue: string): void {
    const waiting = this.delayed.get(queue);
    if (!waiting || waiting.length === 0) return;
    const now = Date.now();
    const stillWaiting: { job: JobData; readyAt: number }[] = [];
    for (const entry of waiting) {
      if (entry.readyAt <= now) {
        const list = this.pending.get(queue) ?? [];
        list.push(entry.job);
        this.pending.set(queue, list);
      } else {
        stillWaiting.push(entry);
      }
    }
    this.delayed.set(queue, stillWaiting);
  }

  async sizeOf(queue: string): Promise<number> {
    return this.pending.get(queue)?.length ?? 0;
  }

  async size(): Promise<number> {
    return this.sizeOf('default');
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  // --- Unused by the transport: present only to satisfy the Adapter contract. ---
  /* c8 ignore start */
  pushLater = this.#unsupported('pushLater');
  pushLaterOn = this.#unsupported('pushLaterOn');
  pushMany = this.#unsupported('pushMany');
  pushManyOn = this.#unsupported('pushManyOn');
  getJob = this.#unsupported('getJob');
  renewJobs = this.#unsupported('renewJobs');
  upsertSchedule = this.#unsupported('upsertSchedule');
  createSchedule = this.#unsupported('createSchedule');
  getSchedule = this.#unsupported('getSchedule');
  listSchedules = this.#unsupported('listSchedules');
  updateSchedule = this.#unsupported('updateSchedule');
  deleteSchedule = this.#unsupported('deleteSchedule');
  claimDueSchedule = this.#unsupported('claimDueSchedule');

  #unsupported(name: string) {
    return async (): Promise<never> => {
      throw new Error(`MockAdapter.${name} is not implemented`);
    };
  }
  /* c8 ignore stop */
}

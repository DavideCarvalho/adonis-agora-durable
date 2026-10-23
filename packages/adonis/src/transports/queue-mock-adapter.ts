import { randomUUID } from 'node:crypto';
import type { AcquiredJob, Adapter, JobData } from '@adonisjs/queue/types';

/** The `{ id, leaseToken }` pair the adapter finalize methods take (`@boringnode/queue` >= 0.8). */
type JobLease = Pick<AcquiredJob, 'id' | 'leaseToken'>;

/** What `recoverStalledJobs` resolves to on the lease contract. */
interface StalledJobsRecovery {
  recovered: number;
  exceeded: AcquiredJob[];
}

/**
 * A tiny in-memory `@adonisjs/queue` adapter for tests — implements just the surface the
 * `QueueTransport` touches (push/pop/complete/fail/retry/renewJobs/recoverStalledJobs/destroy) as plain FIFO
 * queues, plus throwing stubs for the rest of the contract. No Redis, no Knex. `popFrom` mimics the
 * real adapters' atomic move (pending → active) so two transports sharing one instance never
 * double-consume, and the delayed → pending promotion a `retryJob(…, retryAt)` relies on.
 *
 * It follows the `@adonisjs/queue` 0.7 (`@boringnode/queue` 0.9) contract: every claim carries a
 * `leaseToken`, and `completeJob` / `failJob` / `retryJob` take the `{ id, leaseToken }` lease and only
 * finalize the job for the CURRENT lease holder (answering `false` otherwise) — exactly what makes a
 * transport that still passes a bare job id silently finalize nothing.
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

  /** Calls of {@link pushManyOn}, by queue: what a test reads to see a batch went out as one. */
  readonly pushManyCalls: Array<{ queue: string; count: number }> = [];

  async pushManyOn(queue: string, jobs: JobData[]): Promise<void> {
    this.pushManyCalls.push({ queue, count: jobs.length });
    for (const job of jobs) await this.pushOn(queue, job);
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
    const acquired: AcquiredJob = { ...job, acquiredAt: Date.now(), leaseToken: randomUUID() };
    this.active.set(job.id, acquired);
    this.activeQueue.set(job.id, queue);
    return acquired;
  }

  async pop(): Promise<AcquiredJob | null> {
    return this.popFrom('default');
  }

  /** Is `lease` the current claim on an active job? A stale (or missing) lease finalizes nothing. */
  #holds(lease: JobLease): boolean {
    const job = this.active.get(lease?.id);
    return job !== undefined && job.leaseToken === lease.leaseToken;
  }

  async completeJob(lease: JobLease): Promise<boolean> {
    if (!this.#holds(lease)) return false;
    this.active.delete(lease.id);
    this.activeQueue.delete(lease.id);
    return true;
  }

  /** Jobs failed for good, in order — `failJob` keeps them so a test can assert what was failed. */
  readonly failed: AcquiredJob[] = [];

  async failJob(lease: JobLease): Promise<boolean> {
    const job = this.active.get(lease?.id);
    if (!job || !this.#holds(lease)) return false;
    this.active.delete(lease.id);
    this.activeQueue.delete(lease.id);
    this.failed.push(job);
    return true;
  }

  /**
   * Move an active job back for redelivery, counting the attempt — `retryAt` in the future parks it
   * in `delayed` until `popFrom` promotes it, exactly as the real adapters' retry script does. A job
   * that is no longer active (already completed), or whose lease is stale, is a no-op (`false`).
   */
  async retryJob(lease: JobLease, queue: string, retryAt?: Date): Promise<boolean> {
    const job = this.active.get(lease?.id);
    if (!job || !this.#holds(lease)) return false;
    this.active.delete(lease.id);
    this.activeQueue.delete(lease.id);
    const { acquiredAt: _acquiredAt, leaseToken: _leaseToken, ...data } = job;
    const next: JobData = { ...data, attempts: (data.attempts ?? 0) + 1 };
    const readyAt = retryAt?.getTime() ?? 0;
    if (readyAt > Date.now()) {
      const waiting = this.delayed.get(queue) ?? [];
      waiting.push({ job: next, readyAt });
      this.delayed.set(queue, waiting);
      return true;
    }
    await this.pushOn(queue, next);
    return true;
  }

  /**
   * Reclaim jobs of `queue` whose claim is older than `stalledThreshold` (the crashed-worker signal):
   * move each back to `pending` with an incremented `stalledCount`, exactly as the real adapters' Lua/SQL
   * does. A claim younger than the threshold is left active (a slow-but-alive worker). A job that already
   * stalled `maxStalledCount` times is NOT re-delivered: as in `@boringnode/queue` >= 0.8 it stays active,
   * re-leased to the caller (up to `maxExceeded` of them), and comes back in `exceeded` for the caller to
   * fail through `failJob`.
   */
  async recoverStalledJobs(
    queue: string,
    stalledThreshold: number,
    maxStalledCount: number,
    maxExceeded: number,
  ): Promise<StalledJobsRecovery> {
    const now = Date.now();
    const cutoff = now - stalledThreshold;
    let recovered = 0;
    const exceeded: AcquiredJob[] = [];
    for (const [id, job] of [...this.active]) {
      if (this.activeQueue.get(id) !== queue) continue;
      if (job.acquiredAt >= cutoff) continue; // fresh claim — not stalled
      const { acquiredAt: _acquiredAt, leaseToken: _leaseToken, ...data } = job;
      const stalledCount = data.stalledCount ?? 0;
      if (stalledCount >= maxStalledCount) {
        // Exceeded the bound: keep it active under a fresh lease and hand it to the caller to fail.
        if (exceeded.length >= maxExceeded) continue;
        const reLeased: AcquiredJob = { ...job, acquiredAt: now, leaseToken: randomUUID() };
        this.active.set(id, reLeased);
        exceeded.push(reLeased);
        continue;
      }
      this.active.delete(id);
      this.activeQueue.delete(id);
      await this.pushOn(queue, { ...data, stalledCount: stalledCount + 1 });
      recovered += 1;
    }
    return { recovered, exceeded };
  }

  /**
   * Refresh `acquiredAt` of the active jobs of `queue` still held under these leases, as the real
   * adapters' heartbeat does. A lease that is stale (the job was reclaimed, re-leased, or finalized)
   * renews nothing; the count says how many were.
   */
  async renewJobs(queue: string, jobs: JobLease[]): Promise<number> {
    const now = Date.now();
    let renewed = 0;
    for (const lease of jobs) {
      if (this.activeQueue.get(lease.id) !== queue || !this.#holds(lease)) continue;
      const job = this.active.get(lease.id) as AcquiredJob;
      this.active.set(lease.id, { ...job, acquiredAt: now });
      renewed += 1;
    }
    return renewed;
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
  getJob = this.#unsupported('getJob');
  migrate = async (): Promise<void> => {};
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

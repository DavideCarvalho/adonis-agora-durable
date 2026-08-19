/**
 * Flow control for remote steps. A queue caps how much work `ctx.step(step, input, { queue })`
 * admits at once — a concurrency limit and/or a fixed-window rate limit. When a call can't be
 * admitted it doesn't dispatch: the run re-suspends with a near-future wake time, and the timer
 * poller re-tries admission later — so flow control is durable (survives crashes) without holding
 * the run in memory.
 *
 * Accounting is per engine instance (the DBOS `workerConcurrency` tier): correct for the common
 * single-orchestrator deployment. Global, cross-instance limits would need a durable counter in the
 * store — a deliberate follow-up, not built here.
 *
 * Beyond raw caps, the controller can admit contended slots by PRIORITY and by per-KEY FAIRNESS
 * (round-robin), so a single noisy key/tenant can't monopolize the concurrency budget. This is the
 * DISPATCH/admission layer — it never touches workflow replay (engine positional logic). Default
 * behaviour is unchanged FIFO when neither priority nor fairness is configured/passed.
 *
 * Design (vs Temporal/Inngest/DBOS): Temporal task queues are FIFO with separate priority levels;
 * Inngest concurrency keys + throttle give per-key fairness; DBOS queues are FIFO with a
 * `workerConcurrency` cap. We fold both knobs into the same in-process admission gate: an optional
 * per-call `priority` (higher first) and an optional queue-level `fairness: 'key'` (round-robin by
 * the per-call `key`). Because blocked calls re-suspend durably and retry independently (there is no
 * resident FIFO list to reorder), the controller remembers the set of WAITERS that asked-and-were-
 * blocked, and on a later retry only admits the one that is rightful-next under the policy.
 */
export interface QueueConfig {
  /** Queue name, referenced by `ctx.step(step, input, { queue: name })`. */
  name: string;
  /** Max steps in flight at once for this queue (this instance). Omit for unlimited. */
  concurrency?: number;
  /** Fixed-window rate limit: at most `limit` admissions per `periodMs`. Omit for unlimited. */
  rateLimit?: { limit: number; periodMs: number };
  /** Delay (ms) before a concurrency-blocked call re-checks for a free slot. Default 1000. */
  retryMs?: number;
  /**
   * Fairness policy for a contended concurrency slot. `'key'` round-robins across distinct per-call
   * keys (the least-recently-served key wins the next slot), so one key can't monopolize the budget.
   * Omit (or `'fifo'`) for plain first-come ordering. Priority always wins over fairness; fairness
   * only breaks ties within the same priority.
   */
  fairness?: 'fifo' | 'key';
  /**
   * Arrival-order tiebreak among otherwise-equal waiters (same priority, same fairness rank).
   * `'fifo'` (default) admits the earliest arrival; `'lifo'` admits the most recent (a stack).
   * Orthogonal to `priority` and `fairness` — those still win first; this only breaks their ties.
   */
  order?: 'fifo' | 'lifo';
}

/**
 * Per-call admission hints. All optional — omitting them keeps the legacy FIFO behaviour.
 * - `priority`: higher is admitted first (default 0).
 * - `key`: the fairness bucket (e.g. a tenant id) for `fairness: 'key'`.
 * - `waiterId`: a stable id for THIS call across its retries (the engine passes the stepId), so the
 *   controller can track it as one waiter instead of counting each retry as a new contender.
 */
export interface AdmissionItem {
  priority?: number | undefined;
  key?: string | undefined;
  waiterId?: string | undefined;
}

/** Admission decision: either admitted, or blocked until `retryAt` (epoch ms). */
export type Admission = { ok: true } | { ok: false; retryAt: number };

/** A call that asked for a slot and was blocked — remembered so the controller can order admission. */
interface Waiter {
  priority: number;
  key?: string | undefined;
  /** Monotonic registration order — FIFO tiebreak within equal priority/fairness. */
  seq: number;
}

/** In-process admission controller for one {@link QueueConfig}. */
export class QueueController {
  private inFlight = 0;
  private windowStart = 0;
  private windowCount = 0;
  /** Registered waiters by id (only used when priority/fairness ordering is in play). */
  private readonly waiters = new Map<string, Waiter>();
  /** Monotonic counter stamping each newly-seen waiter for a stable FIFO tiebreak. */
  private waiterSeq = 0;
  /** Per-key "last served" order for round-robin fairness — higher = more recently served. */
  private readonly keyServed = new Map<string, number>();
  private servedTick = 0;

  constructor(
    readonly config: QueueConfig,
    private readonly clock: () => number,
  ) {}

  /** Whether this controller does any priority/fairness/arrival ordering (else a plain FIFO gate). */
  private get ordered(): boolean {
    return this.config.fairness === 'key' || this.config.order === 'lifo';
  }

  /**
   * Try to admit one unit of work. On `ok`, the caller has taken a concurrency slot and must call
   * {@link release} when the step settles. On block, `retryAt` is when admission may next succeed.
   *
   * `item` carries optional priority/fairness hints; omitting it is the legacy FIFO path. When
   * ordering is configured (or a priority is given), a blocked call REGISTERS as a waiter and is only
   * admitted on a later retry once it is the rightful next under (priority desc, fairness, FIFO).
   */
  tryAdmit(item?: AdmissionItem): Admission {
    const now = this.clock();
    const rl = this.config.rateLimit;
    // Rate limit is a hard global window — checked first and unaffected by priority/fairness.
    if (rl) {
      if (now - this.windowStart >= rl.periodMs) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      if (this.windowCount >= rl.limit)
        return { ok: false, retryAt: this.windowStart + rl.periodMs };
    }

    const usingOrder = this.ordered || item?.priority != null || item?.waiterId != null;
    const waiterId = item?.waiterId;

    // Concurrency gate.
    const full = this.config.concurrency != null && this.inFlight >= this.config.concurrency;
    if (full) {
      // No slot at all → block (and register as a waiter so a later retry can be ordered).
      if (usingOrder && waiterId != null) this.register(waiterId, item);
      return { ok: false, retryAt: now + (this.config.retryMs ?? 1000) };
    }

    // A slot is free. Without ordering, admit immediately (legacy FIFO). With ordering, only admit if
    // THIS call is the rightful next among all registered waiters — otherwise keep it waiting so the
    // freed slot can go to a higher-priority / under-served key on its retry.
    if (usingOrder && this.waiters.size > 0) {
      if (waiterId != null) this.register(waiterId, item);
      if (!this.isNext(waiterId, item)) {
        return { ok: false, retryAt: now + (this.config.retryMs ?? 1000) };
      }
    }

    // Admit: consume the slot, the rate-window tick, and clear this waiter.
    if (rl) this.windowCount += 1;
    this.inFlight += 1;
    if (waiterId != null) this.waiters.delete(waiterId);
    if (item?.key != null) this.keyServed.set(item.key, ++this.servedTick);
    return { ok: true };
  }

  /** Release a concurrency slot taken by a successful {@link tryAdmit}. */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /** Track (or refresh) a blocked call as a waiter; its FIFO seq is stamped only on first sight. */
  private register(waiterId: string, item?: AdmissionItem): void {
    const existing = this.waiters.get(waiterId);
    if (existing) {
      existing.priority = item?.priority ?? 0;
      existing.key = item?.key;
      return;
    }
    this.waiters.set(waiterId, {
      priority: item?.priority ?? 0,
      key: item?.key,
      seq: this.waiterSeq++,
    });
  }

  /**
   * Is the calling item the best candidate among all registered waiters? Ordering, best first:
   *   1. higher `priority`;
   *   2. fairness: with `fairness: 'key'`, the least-recently-served key wins (round-robin);
   *   3. earliest registration (FIFO) — stable tiebreak.
   * A bare item (no waiterId) is compared on its hints directly.
   */
  private isNext(waiterId: string | undefined, item?: AdmissionItem): boolean {
    const self: Waiter =
      (waiterId != null ? this.waiters.get(waiterId) : undefined) ??
      ({ priority: item?.priority ?? 0, key: item?.key, seq: Number.POSITIVE_INFINITY } as Waiter);
    let best = self;
    for (const w of this.waiters.values()) {
      if (this.better(w, best)) best = w;
    }
    return best === self;
  }

  /** Strict "a should be admitted before b" comparison under the active policy. */
  private better(a: Waiter, b: Waiter): boolean {
    if (a.priority !== b.priority) return a.priority > b.priority;
    if (this.config.fairness === 'key') {
      const sa = this.servedOf(a.key);
      const sb = this.servedOf(b.key);
      if (sa !== sb) return sa < sb; // least-recently-served key first
    }
    return this.config.order === 'lifo' ? a.seq > b.seq : a.seq < b.seq; // arrival tiebreak
  }

  /** Last-served tick for a key (0 = never served, so an unseen key is admitted before a busy one). */
  private servedOf(key?: string): number {
    if (key == null) return 0;
    return this.keyServed.get(key) ?? 0;
  }
}

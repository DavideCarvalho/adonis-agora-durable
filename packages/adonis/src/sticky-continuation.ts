import { WorkflowSuspended } from './errors.js';
import type { StepCheckpoint } from './interfaces.js';
import type { Compensation } from './workflow-ctx.js';

/**
 * Sticky continuations: the in-memory half of a run's turn, kept between turns so a dispatched step's
 * result does not replay the workflow body from the top.
 *
 * Without them, a `ctx.step` that dispatches throws {@link WorkflowSuspended}: the body unwinds, the
 * turn settles `suspended` and the next turn (the step's result landing) replays the body over the
 * run's whole history. That costs a history read and a body replay per step.
 *
 * With a continuation attached, the dispatching call does not throw. It PARKS: its promise stays
 * pending, and once every other primitive the body started has settled or parked too (the body is
 * quiescent), the turn settles `suspended` exactly as before (same writes, same lease release). The
 * body itself stays alive, parked on that promise, in a bounded per-process cache. The next turn of
 * the run on this process (its lease taken again as usual) re-evaluates each parked call against the
 * store (the same code a replay runs at that position: completed → its output, failed → retry or
 * throw, still pending → stay parked) and lets the body continue from there. Everything past the
 * parked positions reads the store, exactly as a replay reads positions past its snapshot.
 *
 * Why that is equivalent to a replay: the body's in-memory state at the park point is a function of
 * the run's history up to the highest position it touched, and that part of the history does not
 * change while the run is suspended (completed checkpoints are immutable; the parked ones are
 * re-read). The cases where it can change all leave a trace on the run row (a settle by another
 * turn, a retry, a cancel), so a warm turn only proceeds when the row still carries the stamp this
 * process wrote when it parked; anything else falls back to a full replay.
 *
 * A body that calls a primitive while detached (between turns, without the lease: a raw timer or
 * fetch it awaited outside the ctx) poisons its continuation: the call is refused before it writes
 * anything, and the run's next turn replays. A turn where any other primitive suspended the classic
 * way (a sleep, a signal, a child) is not kept either.
 */

/** The outcome a turn waits for: the body settled, or it is parked on dispatched steps. */
export type TurnOutcome =
  | { kind: 'returned'; value: unknown }
  | { kind: 'threw'; error: unknown }
  | { kind: 'parked'; wakeAt: number | undefined; waitSeqs: number[] };

/** A dispatched call parked by the body, waiting for a later turn to re-evaluate it. */
export interface ParkedCall {
  seq: number;
  wakeAt: number | undefined;
  /** Re-run the call's own logic (the same a replay runs). `fresh` is its checkpoint, read for it. */
  reevaluate(fresh: StepCheckpoint | null): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class StickyContinuation {
  /** The body's settled outcome, once it has one. */
  private outcome: TurnOutcome | undefined;
  /** Primitives started by the body and not yet settled or parked. */
  private active = 0;
  /** Bumped on every change, so a quiescence check can tell nothing happened in between. */
  private version = 0;
  private checkScheduled = false;
  private waiter: ((outcome: TurnOutcome) => void) | undefined;
  readonly parked = new Map<number, ParkedCall>();
  /** A turn currently owns the body (holds the run's lease). */
  attached = true;
  /** The body called a primitive while detached, or one suspended the classic way: never reuse it. */
  unusable = false;
  /** The run row's `updatedAt` (epoch ms) this process wrote when the body last parked. */
  stamp: number | undefined;
  lastUsed = Date.now();
  /**
   * Parked steps' `completed` rows, as the instance that settled them read them back: the next turn
   * takes them instead of reading them again. A completed row never changes, so the hint can only be
   * missing, never stale.
   */
  readonly hints = new Map<number, StepCheckpoint>();

  constructor(
    readonly runId: string,
    /** Identity of the registered body, so a re-registration is never resumed with an old one. */
    readonly fn: unknown,
    readonly workflowVersion: string,
    readonly compensations: Compensation[],
    readonly replay: Map<number, StepCheckpoint>,
    readonly onPoisoned: (c: StickyContinuation) => void,
  ) {}

  /** Remember a parked step's settled row for the next turn (see {@link hints}). */
  hint(cp: StepCheckpoint): void {
    if (cp.status === 'completed' && this.parked.has(cp.seq)) this.hints.set(cp.seq, cp);
  }

  /** Start the body. `run` invokes it (inside the ambient workflow ctx). */
  begin(run: () => Promise<unknown>): void {
    let started: Promise<unknown>;
    try {
      started = run();
    } catch (error) {
      started = Promise.reject(error);
    }
    started.then(
      (value) => this.settle({ kind: 'returned', value }),
      (error) => this.settle({ kind: 'threw', error }),
    );
  }

  private settle(outcome: TurnOutcome): void {
    this.outcome = outcome;
    this.changed();
  }

  /**
   * Called by every primitive the body starts. `false` refuses the call: the body is detached (no
   * turn holds the lease), and this continuation is poisoned.
   */
  enter(): boolean {
    if (!this.attached) {
      if (!this.unusable) {
        this.unusable = true;
        this.onPoisoned(this);
      }
      return false;
    }
    this.active += 1;
    this.changed();
    return true;
  }

  /** A primitive the body started settled. A classic suspension makes the body single-use. */
  exit(error?: unknown): void {
    this.active -= 1;
    if (error instanceof WorkflowSuspended) this.unusable = true;
    this.changed();
  }

  /**
   * Park a dispatched call: it stops counting as active, and its promise settles when a later turn
   * re-evaluates it to an outcome.
   */
  park(
    seq: number,
    wakeAt: number | undefined,
    reevaluate: ParkedCall['reevaluate'],
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.parked.set(seq, { seq, wakeAt, reevaluate, resolve, reject });
      this.active -= 1;
      this.changed();
    });
  }

  /**
   * Re-evaluate every parked call (in position order) with its freshly read checkpoint. A call that
   * has an outcome leaves the parked set and settles; one still waiting stays parked, with its new
   * deadline. Run by a warm turn after it attached.
   */
  async resumeParked(fresh: Map<number, StepCheckpoint | null>): Promise<void> {
    const calls = [...this.parked.values()].sort((a, b) => a.seq - b.seq);
    for (const call of calls) {
      try {
        const value = await call.reevaluate(fresh.get(call.seq) ?? null);
        this.parked.delete(call.seq);
        this.active += 1; // balanced by the primitive's own exit once it settles
        call.resolve(value);
      } catch (error) {
        if (error instanceof WorkflowSuspended) {
          call.wakeAt = error.wakeAt;
          continue;
        }
        this.parked.delete(call.seq);
        this.active += 1;
        call.reject(error);
      }
    }
    this.changed();
  }

  /**
   * Wait for this turn's outcome: the body settled, or it is parked on at least one dispatched call
   * with nothing else in flight. Quiescence is confirmed a macrotask later with nothing changed in
   * between, so microtask continuations of the body (a `Promise.all` starting its next call) run
   * first. Parking detaches the body.
   */
  next(): Promise<TurnOutcome> {
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.changed();
    });
  }

  private changed(): void {
    this.version += 1;
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.outcome) {
      this.waiter = undefined;
      waiter(this.outcome);
      return;
    }
    if (this.checkScheduled || this.parked.size === 0 || this.active > 0) return;
    this.checkScheduled = true;
    const at = this.version;
    setImmediate(() => {
      this.checkScheduled = false;
      if (this.waiter !== waiter) return;
      if (this.version !== at) {
        this.changed();
        return;
      }
      if (this.outcome || this.parked.size === 0 || this.active > 0) return;
      this.waiter = undefined;
      this.attached = false;
      let wakeAt: number | undefined;
      for (const call of this.parked.values()) {
        if (call.wakeAt !== undefined) wakeAt = Math.min(wakeAt ?? call.wakeAt, call.wakeAt);
      }
      waiter({ kind: 'parked', wakeAt, waitSeqs: [...this.parked.keys()] });
    });
  }
}

/**
 * The per-process cache of parked continuations, by run id: bounded by count (least recently used
 * out first) and by idle time. Taking an entry removes it, so a continuation is owned by at most one
 * turn at a time.
 */
export class StickyCache {
  private readonly entries = new Map<string, StickyContinuation>();
  hits = 0;
  misses = 0;

  constructor(
    readonly maxEntries: number,
    readonly maxIdleMs: number,
  ) {}

  get enabled(): boolean {
    return this.maxEntries > 0;
  }

  get size(): number {
    return this.entries.size;
  }

  put(c: StickyContinuation): void {
    if (!this.enabled || c.unusable) return;
    c.lastUsed = Date.now();
    this.entries.delete(c.runId);
    this.entries.set(c.runId, c);
    this.prune(c.lastUsed);
  }

  take(runId: string): StickyContinuation | undefined {
    const c = this.entries.get(runId);
    if (!c) return undefined;
    this.entries.delete(runId);
    if (c.unusable || Date.now() - c.lastUsed > this.maxIdleMs) return undefined;
    return c;
  }

  /** The parked continuation of `runId`, left in place. */
  peek(runId: string): StickyContinuation | undefined {
    return this.entries.get(runId);
  }

  has(runId: string): boolean {
    return this.entries.has(runId);
  }

  evict(runId: string): void {
    this.entries.delete(runId);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    for (const [runId, c] of this.entries) {
      if (now - c.lastUsed <= this.maxIdleMs) break;
      this.entries.delete(runId);
    }
  }
}

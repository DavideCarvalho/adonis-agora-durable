/** A running poll loop. Call {@link PollLoop.stop} to end just this one. */
export interface PollLoop {
  stop(): void;
}

export interface PollersOptions {
  /**
   * Random spread applied to every sleep: a ratio `r` sleeps `interval × (1 − r … 1 + r)`. Breaks
   * the thundering herd of identical pods whose loops align and race the same oldest-first rows
   * every tick. Default `0.2` (±20%); `0` disables (exact interval — what tests with fake clocks
   * want).
   */
  jitterRatio?: number;
  /**
   * Idle backoff: after consecutive empty rounds the sleep doubles, capped at
   * `idleBackoffMax × interval`; any round that finds work resets to the base interval. Default `1`
   * (off — every sleep is the base interval), because a longer idle sleep is added LATENCY for the
   * first job after a quiet spell; opt in on loops whose work is latency-tolerant.
   */
  idleBackoffMax?: number;
}

/**
 * The shared poll-loop lifecycle for poll-based transports (DB-row pollers, queue-adapter
 * pollers). Each loop runs its `tick` repeatedly: while a tick reports it did work the loop
 * keeps draining without sleeping (so a burst is processed promptly), then sleeps `intervalMs`
 * once a tick comes back empty. A throwing tick is reported to `onError` (if given) and the loop
 * survives. Every loop is tracked so {@link stopAll} can end them together on shutdown, and every
 * loop's IN-FLIGHT tick is tracked so {@link drain} can wait for work already picked up.
 *
 * Timers are `unref`'d so a quiescent poller never holds the process open.
 *
 * This is the one place the queue- and DB-backed transports would otherwise duplicate the subtle
 * recursive-`setTimeout` / drain-burst / stop-all bookkeeping; both drive it through this class.
 */
export class Pollers {
  readonly #loops = new Set<PollLoop>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #intervalMs: number;
  readonly #onError: ((err: unknown) => void) | undefined;
  readonly #jitterRatio: number;
  readonly #idleBackoffMax: number;
  #closed = false;

  constructor(intervalMs: number, onError?: (err: unknown) => void, options?: PollersOptions) {
    this.#intervalMs = intervalMs;
    this.#onError = onError;
    this.#jitterRatio = Math.max(0, Math.min(options?.jitterRatio ?? 0.2, 1));
    this.#idleBackoffMax = Math.max(1, options?.idleBackoffMax ?? 1);
  }

  /** Whether {@link stopAll} has been called — loops won't run until {@link reopen}. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Re-open after a {@link stopAll} so loops started afterwards may run again. */
  reopen(): void {
    this.#closed = false;
  }

  /** The next sleep for a loop that has seen `idleRounds` consecutive empty rounds, jittered. */
  #sleepMs(idleRounds: number): number {
    const backoff = Math.min(2 ** Math.min(idleRounds, 30), this.#idleBackoffMax);
    const base = this.#intervalMs * backoff;
    if (this.#jitterRatio === 0) return base;
    return Math.round(base * (1 - this.#jitterRatio + 2 * this.#jitterRatio * Math.random()));
  }

  /**
   * Start a loop driven by `tick`. `tick` resolves to whether it did any work this round; while it
   * keeps returning `true` the loop drains without sleeping, then sleeps `intervalMs` once a round
   * is empty. Returns a handle that stops just this loop (also stopped by {@link stopAll}).
   */
  start(tick: () => Promise<boolean>): PollLoop {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleRounds = 0;

    const run = async (): Promise<void> => {
      if (stopped || this.#closed) return;
      try {
        let worked = await tick();
        if (worked) idleRounds = 0;
        while (worked && !stopped && !this.#closed) {
          worked = await tick();
        }
      } catch (err) {
        if (!stopped && !this.#closed) this.#onError?.(err);
      }
      idleRounds += 1;
      if (!stopped && !this.#closed) {
        timer = setTimeout(() => track(), this.#sleepMs(idleRounds - 1));
        timer.unref?.();
      }
    };

    // Track each round so drain() can await work already in flight (a popped job mid-handler).
    const track = (): void => {
      const p = run().catch(() => undefined);
      this.#inflight.add(p);
      void p.finally(() => this.#inflight.delete(p));
    };

    const loop: PollLoop = {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        this.#loops.delete(loop);
      },
    };
    this.#loops.add(loop);
    track();
    return loop;
  }

  /** Stop and forget every running loop, and mark closed so in-flight ticks stop early. */
  stopAll(): void {
    this.#closed = true;
    for (const loop of this.#loops) loop.stop();
    this.#loops.clear();
  }

  /**
   * Wait (up to `timeoutMs`) for every in-flight tick to settle — the work a loop already picked up
   * before {@link stopAll}. Lets a transport's `close()` finish (complete/ack) the job it popped
   * instead of tearing the adapter down under it and stranding the job in the broker's active set
   * until the stalled sweep. Resolves `true` when everything settled, `false` on timeout.
   */
  async drain(timeoutMs = 5_000): Promise<boolean> {
    const timer = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), timeoutMs);
      (t as { unref?: () => void }).unref?.();
    });
    while (this.#inflight.size > 0) {
      const settled = Promise.allSettled([...this.#inflight]);
      const outcome = await Promise.race([settled, timer]);
      if (outcome === 'timeout') return false;
    }
    return true;
  }
}

/**
 * Per-routing-token concurrency for the grouped task queue (`taskQueues: 'grouped'`).
 *
 * With one BullMQ queue per handler, BullMQ's `Worker` concurrency caps each handler on its own. When
 * every handler of a partition shares ONE queue, the worker's concurrency is the sum of the handlers'
 * limits, and this limiter keeps each handler at its own limit: a job of a handler already at its
 * limit waits here (its BullMQ lock keeps renewing) until one of that handler's jobs finishes. Waiters
 * are served first in, first out.
 *
 * Pure (no timers, no Redis), so it unit-tests on its own.
 */
export class HandlerLimiter {
  #limit: number;
  readonly #tokens = new Map<string, TokenState>();

  constructor(limit: number) {
    this.#limit = normalizeLimit(limit);
  }

  /** How many jobs of one token may run at once. */
  get limit(): number {
    return this.#limit;
  }

  /** Change the per-token limit (the adaptive controller moves it). Raising it starts waiters at once. */
  setLimit(limit: number): void {
    this.#limit = normalizeLimit(limit);
    for (const [token, state] of this.#tokens) this.#grant(token, state);
  }

  /** Jobs of `token` running now. */
  running(token: string): number {
    return this.#tokens.get(token)?.running ?? 0;
  }

  /** Jobs of `token` waiting for a slot. */
  waiting(token: string): number {
    return this.#tokens.get(token)?.waiters.length ?? 0;
  }

  /** Mean duration (ms) of `token`'s recent jobs (an exponential moving average), if any finished. */
  averageMs(token: string): number | undefined {
    return this.#tokens.get(token)?.averageMs;
  }

  /** Take a slot now if `token` is under its limit and nobody waits ahead. */
  tryAcquire(token: string): boolean {
    const state = this.#state(token);
    if (state.running >= this.#limit || state.waiters.length > 0) return false;
    state.running += 1;
    return true;
  }

  /**
   * Wait for a slot of `token`. `ready` resolves once the slot is held; `cancel()` gives up the place in
   * line, or the slot itself when it was already granted, so a job handed back while it waited never
   * leaks one.
   */
  acquire(token: string): { ready: Promise<void>; cancel: () => void } {
    if (this.tryAcquire(token)) {
      let held = true;
      return {
        ready: Promise.resolve(),
        cancel: () => {
          if (held) this.release(token);
          held = false;
        },
      };
    }
    const state = this.#state(token);
    let waiter!: Waiter;
    const ready = new Promise<void>((resolve) => {
      waiter = { granted: false, cancelled: false, resolve };
    });
    state.waiters.push(waiter);
    return {
      ready,
      cancel: () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        if (waiter.granted) {
          this.release(token);
          return;
        }
        const at = state.waiters.indexOf(waiter);
        if (at !== -1) state.waiters.splice(at, 1);
      },
    };
  }

  /** Give a slot of `token` back, recording how long its job ran, and start the next waiter. */
  release(token: string, durationMs?: number): void {
    const state = this.#tokens.get(token);
    if (!state) return;
    state.running = Math.max(0, state.running - 1);
    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      state.averageMs =
        state.averageMs === undefined ? durationMs : state.averageMs * 0.8 + durationMs * 0.2;
    }
    this.#grant(token, state);
  }

  #grant(token: string, state: TokenState): void {
    while (state.running < this.#limit && state.waiters.length > 0) {
      const waiter = state.waiters.shift() as Waiter;
      if (waiter.cancelled) continue;
      waiter.granted = true;
      state.running += 1;
      waiter.resolve();
    }
    if (state.running === 0 && state.waiters.length === 0 && state.averageMs === undefined) {
      this.#tokens.delete(token);
    }
  }

  #state(token: string): TokenState {
    let state = this.#tokens.get(token);
    if (!state) {
      state = { running: 0, waiters: [], averageMs: undefined };
      this.#tokens.set(token, state);
    }
    return state;
  }
}

interface Waiter {
  granted: boolean;
  cancelled: boolean;
  resolve: () => void;
}

interface TokenState {
  running: number;
  waiters: Waiter[];
  averageMs: number | undefined;
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
}

import type { StepOptions } from './interfaces.js';

/**
 * Absolute ceiling for any computed backoff delay: Node's `setTimeout` max (2³¹−1 ms ≈ 24.8 days).
 * Above it Node silently clamps the timer to fire ~immediately — so an uncapped exponential
 * (`2 ** attempt` overflows into Infinity around attempt ~40) would turn "wait a very long time"
 * into a HOT retry loop. Clamping to the max keeps the intent (an extremely long wait) representable.
 */
export const MAX_BACKOFF_MS = 2 ** 31 - 1;

/** Delay in ms before the next retry attempt, per a step's `StepOptions` backoff config. Shared by
 *  the local-step retry loop and the durable remote-step retry, so they stay consistent. */
export function backoffDelay(attempt: number, options?: StepOptions): number {
  const base = options?.backoffMs ?? 0;
  if (base <= 0) return 0;
  // Cap the exponent before multiplying: `2 ** (attempt - 1)` reaches Infinity long before the
  // MAX_BACKOFF_MS clamp below could catch it, and `Infinity * 0` jitter would produce NaN.
  const raw = options?.backoff === 'exp' ? base * 2 ** Math.min(attempt - 1, 31) : base;
  const capped = options?.backoffMaxMs ? Math.min(raw, options.backoffMaxMs) : raw;
  const clamped = Math.min(capped, MAX_BACKOFF_MS);
  return options?.jitter ? Math.round(clamped * (0.5 + Math.random() * 0.5)) : clamped;
}

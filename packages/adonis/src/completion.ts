import { FatalError } from './errors.js';
import type { StepError } from './interfaces.js';

/**
 * The payload an external `ctx.task` / child run delivers back on its completion signal: either a
 * value or a failure. One typed envelope so `task` and `child` share the same unwrap (instead of
 * sniffing ad-hoc `__error` keys).
 */
export type Completion<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string | undefined; details?: unknown };

/** Whether a signal payload is a failed `Completion`. */
export function isFailedCompletion(payload: unknown): boolean {
  const c = payload as Completion<unknown> | null;
  return !!c && typeof c === 'object' && 'ok' in c && c.ok === false;
}

/** Read a `Completion` from a signal payload: return the value, or throw a FatalError if it failed. */
export function unwrapCompletion<T>(payload: unknown, label: string): T {
  const c = payload as Completion<T> | null;
  if (c && typeof c === 'object' && 'ok' in c && c.ok === false) {
    throw new FatalError(`${label} failed: ${c.error}`, c.code, c.details);
  }
  return (c as { value: T } | null)?.value as T;
}

/** The failed {@link Completion} a run's failure notifies its parent with. */
export function failedCompletion(error: StepError): Completion<never> {
  return {
    ok: false,
    error: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}

/** A failed {@link Completion} as the `StepError` it was made from. */
export function completionError(c: {
  error: string;
  code?: string | undefined;
  details?: unknown;
}): StepError {
  return {
    message: c.error,
    ...(c.code !== undefined ? { code: c.code } : {}),
    ...(c.details !== undefined ? { details: c.details } : {}),
  };
}

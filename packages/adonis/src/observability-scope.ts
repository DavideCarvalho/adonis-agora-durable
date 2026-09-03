/**
 * Telling an observability tool WHAT this work is, without depending on one.
 *
 * `@adonis-agora/telescope` publishes a scope driver on the global slot
 * `Symbol.for('@agora/telescope:origin-scope')`. We read it structurally — the same
 * stance {@link withRestoredContext} takes with `@adonis-agora/context` — so durable
 * never grows a dependency on a debugging tool just to be legible inside one, and
 * every helper here degrades to `fn()` when the slot is absent.
 *
 * Two labels, and the difference between them is the whole point:
 *
 * - **origin** (`withOrigin('schedule', …)`) says work came from the worker tick
 *   rather than an HTTP request. It is metadata ON an entry.
 * - **heartbeat** (`asHeartbeat(…)`) says a read is a liveness PROBE — the tick
 *   asking the store "is there anything to do?". It is a reason NOT to write an
 *   entry at all.
 *
 * Wrap ONLY the probe in {@link asHeartbeat}, never the work it finds. A tick that
 * picks up a run must still record the lease, the checkpoints and the result: that
 * is the run's history, and it is exactly what someone debugging a stuck workflow
 * opens the console to see. Getting this boundary wrong in either direction is the
 * failure mode — too wide and real work goes dark, too narrow and the noise stays.
 */
const ORIGIN_SCOPE = Symbol.for('@agora/telescope:origin-scope');

/** The narrow shape telescope publishes. Mirrored structurally, never imported. */
interface OriginScopeDriver {
  run<T>(scope: { origin?: string; heartbeat?: boolean }, fn: () => T): T;
}

function driver(): OriginScopeDriver | undefined {
  // Resolved per call, never cached at module load: durable is imported by the
  // provider before telescope's own provider has necessarily run, and a driver
  // captured too early would be `undefined` forever.
  const slot = (globalThis as Record<symbol, unknown>)[ORIGIN_SCOPE];
  return typeof (slot as OriginScopeDriver | undefined)?.run === 'function'
    ? (slot as OriginScopeDriver)
    : undefined;
}

/**
 * Run `fn` inside `scope` when a driver is installed, else run it plain.
 *
 * Branch explicitly rather than `driver()?.run(...) ?? fn()`: a workflow body may
 * legitimately resolve to `undefined`, and `??` cannot tell that apart from "no
 * driver" — it would run `fn` a SECOND time. For a tick that leases and executes
 * runs, running it twice is not a cosmetic bug.
 */
function within<T>(scope: { origin?: string; heartbeat?: boolean }, fn: () => T): T {
  const active = driver();
  return active === undefined ? fn() : active.run(scope, fn);
}

/** Run `fn` labelled as scheduler-driven work (telescope's `origin: 'schedule'`). */
export function withScheduleOrigin<T>(fn: () => T): T {
  return within({ origin: 'schedule' }, fn);
}

/**
 * Run `fn` marked as a liveness probe, so an observability tool can drop it.
 *
 * Use it around a single store READ that answers "is there work?" — nothing else.
 */
export function asHeartbeat<T>(fn: () => T): T {
  return within({ heartbeat: true }, fn);
}

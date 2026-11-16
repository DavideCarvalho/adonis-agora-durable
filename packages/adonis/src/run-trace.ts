import { createHash, randomBytes } from 'node:crypto';

/**
 * One trace per run, shared by the control plane and the tenant pod that runs the run's steps.
 *
 * On a control plane, the lifecycle entries of a tenant's run are recorded by the control plane, and
 * what happens INSIDE a step (its queries, HTTP calls, exceptions) by the tenant pod that executed it,
 * when that pod runs Telescope too. Both sides derive the same trace id from the run id, so the two
 * views join on `trace:<id>` without either side calling the other.
 */

/** The trace id of `runId`: 32 lowercase hex, never all zeros. Stable across processes. */
export function runTraceId(runId: string): string {
  const hex = createHash('sha256').update(`durable:run:${runId}`).digest('hex').slice(0, 32);
  return /^0+$/.test(hex) ? `${hex.slice(0, 31)}1` : hex;
}

/** The trace scope `@adonis-agora/telescope` keeps per unit of work (structural mirror). */
interface TraceScopeLike {
  upstreamTraceId: string | null;
  fallbackTraceId: string;
  spanId: string;
  parentSpanId: string | null;
  flags: string;
}

/** The `AsyncLocalStorage` Telescope publishes its trace scope on (structural, never imported). */
const TRACE_SCOPE = Symbol.for('@agora/telescope:trace-scope');

interface ScopeStorage {
  run<T>(scope: TraceScopeLike, fn: () => T): T;
}

const ENABLED = Symbol.for('@agora/durable:run-trace-scope');

/**
 * Run the work of a tenant pod (a step handler, a workflow turn) inside its run's trace, so every
 * Telescope entry it records carries `trace:<runTraceId(runId)>`. Turned on by the provider on a
 * `tenant` pod only (see {@link enableRunTraceScope}); elsewhere, and without Telescope, it runs `fn`
 * as is. An OpenTelemetry span active in the pod still wins in Telescope's own trace resolution.
 */
export function withRunTrace<T>(task: { runId: string }, fn: () => T): T {
  if ((globalThis as Record<symbol, unknown>)[ENABLED] !== true) return fn();
  const storage = (globalThis as Record<symbol, unknown>)[TRACE_SCOPE] as ScopeStorage | undefined;
  if (typeof storage?.run !== 'function') return fn();
  const traceId = runTraceId(task.runId);
  return storage.run(
    {
      upstreamTraceId: traceId,
      fallbackTraceId: traceId,
      spanId: randomBytes(8).toString('hex'),
      parentSpanId: null,
      flags: '01',
    },
    fn,
  );
}

/** Turn {@link withRunTrace} on (`true`) or off for this process. The `tenant` provider turns it on. */
export function enableRunTraceScope(enabled = true): void {
  if (enabled) (globalThis as Record<symbol, unknown>)[ENABLED] = true;
  else delete (globalThis as Record<symbol, unknown>)[ENABLED];
}

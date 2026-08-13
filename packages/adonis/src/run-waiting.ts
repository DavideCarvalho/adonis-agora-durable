import { EVENT_TOKEN_PREFIX, eventNameOf } from './events.js';
import type { RunWaiting, SignalWaiter, WorkflowRun } from './interfaces.js';

/**
 * Port of `@dudousxd/nestjs-durable-core`'s `run-waiting.ts`, byte-for-byte (this package's
 * `SignalWaiter` token conventions are identical — see `workflow-ctx.ts`/`protocol.ts`/`events.ts`).
 *
 * Waiter-token prefixes the engine stamps: a webhook mints `wh:<runId>:<seq>` (`workflow-ctx.ts`), an
 * awaited child parks on `child:<id>`, `ctx.breakpoint` mints `bp:<runId>:<seq>` (`breakpointToken` in
 * `protocol.ts`), a named event on `event:<b64 name>:…` (`events.ts`). A plain `ctx.waitForSignal(name)`
 * uses `name` verbatim as the token, so an unrecognised token IS the signal name.
 */
const WEBHOOK_PREFIX = 'wh:';
const CHILD_PREFIX = 'child:';
const BREAKPOINT_PREFIX = 'bp:';
const EVENT_PREFIX = EVENT_TOKEN_PREFIX;

/**
 * Resolve WHAT a suspended run is parked on from the token of the {@link SignalWaiter} it registered.
 * The token prefix carries the kind — no extra store lookup and no new persisted field. Used by
 * {@link resolveRunWaiting} to stamp {@link RunWaiting} onto each listed run so the dashboard can name
 * the wait in a row without fetching that run's timeline.
 *
 * `ctx.breakpoint` reuses the signal-waiter machinery (`engine.continue` resumes it via `signal()`
 * like any other), so without this case it would fall through to the generic `signal` branch with the
 * raw `bp:<runId>:<seq>` token as its display name — a real bug. Named `'breakpoint'` here instead;
 * the token carries no separate label to recover cheaply (see {@link RunWaiting.name}).
 */
export function classifyWaiterToken(token: string): RunWaiting {
  if (token.startsWith(WEBHOOK_PREFIX)) return { on: 'webhook', name: token };
  if (token.startsWith(BREAKPOINT_PREFIX)) return { on: 'breakpoint', name: 'breakpoint' };
  if (token.startsWith(CHILD_PREFIX))
    return { on: 'child', name: token.slice(CHILD_PREFIX.length) };
  if (token.startsWith(EVENT_PREFIX)) return { on: 'signal', name: eventNameOf(token) };
  return { on: 'signal', name: token };
}

/**
 * Resolve a suspended run's {@link RunWaiting} from the pending signal waiters (indexed by `runId`).
 * Event-only by design (see {@link RunWaiting}): a `waitForSignal`/`waitForEvent`/webhook/awaited-child
 * suspend registers a waiter and gets named here; every other suspend (a bare `ctx.sleep`, an in-flight
 * remote step, a reconcile-parked orphan) returns `undefined`, so the client layers its own display
 * state (no-worker, singleton, running) on top — none of which can be told apart from `wakeAt` alone.
 */
export function resolveRunWaiting(
  run: WorkflowRun,
  waiterByRun: ReadonlyMap<string, SignalWaiter>,
): RunWaiting | undefined {
  if (run.status !== 'suspended') return undefined;
  const waiter = waiterByRun.get(run.id);
  return waiter ? classifyWaiterToken(waiter.token) : undefined;
}

/** Index signal waiters by `runId`, keeping the first seen per run (a run parks on one waiter at a
 *  time in the sequential case; the earliest is the one it's blocked on). */
export function indexWaitersByRun(waiters: readonly SignalWaiter[]): Map<string, SignalWaiter> {
  const byRun = new Map<string, SignalWaiter>();
  for (const w of waiters) if (!byRun.has(w.runId)) byRun.set(w.runId, w);
  return byRun;
}

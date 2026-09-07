import type { RunWaiting, StepCheckpoint } from './durable-client.js';

/**
 * What the console can DO about a suspended run's wait — the client side of the server's
 * human-in-the-loop verbs (`handlers.ts`'s `signalRun`/`updateRun`/`completeTaskRun`/`failTaskRun`).
 *
 * The engine parks every external rendezvous on one signal-waiter table, and the TOKEN carries the
 * shape (see `packages/adonis/src/run-waiting.ts` and `workflow-ctx.ts`):
 *
 *  - `update:<runId>:<name>` — a `ctx.onUpdate(name)` point → `POST /runs/:id/update/:name`
 *  - `task:<runId>:<name>`   — an external `ctx.task`      → `POST /runs/:id/tasks/:name/complete|fail`
 *  - anything else            — a plain `ctx.waitForSignal` token (incl. `wh:` webhooks)
 *                               → `POST /runs/:id/signal`
 *  - `bp:`/`breakpoint` and `child:` tokens are NOT actions here: a breakpoint already has the
 *    Continue button (`POST /runs/:id/continue`), and an awaited child resolves by itself — offering
 *    "deliver a signal" on either would fabricate a completion the engine did not ask a human for.
 */
export type WaitTarget =
  | { kind: 'signal'; token: string }
  | { kind: 'update'; token: string; name: string }
  | { kind: 'task'; token: string; name: string };

const UPDATE_PREFIX = 'update:';
const TASK_PREFIX = 'task:';
const CHILD_PREFIX = 'child:';
const BREAKPOINT_PREFIXES = ['bp:', 'breakpoint'];

/** Split a run-scoped `<prefix><runId>:<name>` token into its `name`, or `undefined` when the token
 *  does not carry the second separator (then it's just an oddly named plain signal). */
function runScopedName(token: string, prefix: string): string | undefined {
  const rest = token.slice(prefix.length);
  const sep = rest.indexOf(':');
  if (sep === -1) return undefined;
  const name = rest.slice(sep + 1);
  return name.length > 0 ? name : undefined;
}

/** Classify one waiter token into the console action that answers it, or `undefined` for a wait no
 *  human verb should touch (breakpoints have Continue; children complete themselves). */
export function classifyWaitToken(token: string): WaitTarget | undefined {
  if (BREAKPOINT_PREFIXES.some((p) => token.startsWith(p))) return undefined;
  if (token.startsWith(CHILD_PREFIX)) return undefined;
  if (token.startsWith(UPDATE_PREFIX)) {
    const name = runScopedName(token, UPDATE_PREFIX);
    if (name !== undefined) return { kind: 'update', token, name };
  }
  if (token.startsWith(TASK_PREFIX)) {
    const name = runScopedName(token, TASK_PREFIX);
    if (name !== undefined) return { kind: 'task', token, name };
  }
  return { kind: 'signal', token };
}

/**
 * Every actionable wait a run detail can act on, deduped by token, from the two places a token
 * surfaces client-side:
 *
 *  1. the timeline's in-flight `signal` checkpoints — `ctx.waitForSignal(token)` checkpoints under
 *     the token's own name (`tokenDetail` in `durable-client.ts` reads the same field);
 *  2. the run's list-row `waiting` stamp (`GET /runs`' bulk waiter scan) — only there when the
 *     timeline holds no pending signal checkpoint (a reconcile-parked wait), and only for the kinds
 *     whose `name` IS the token (`signal`/`webhook`; a `child`/`breakpoint` name is a label).
 *
 * NOTE the `waiting` fallback is best-effort: a `waitForEvent` wait surfaces its DECODED event name
 * there, not the `event:<b64>:…` token — delivering on it answers 409 with the real `waitingOn`
 * list, which the deliver-signal dialog then offers as selectable tokens.
 */
export function waitTargetsOf(
  timeline: readonly Pick<StepCheckpoint, 'kind' | 'status' | 'name'>[],
  waiting?: RunWaiting,
): WaitTarget[] {
  const tokens: string[] = [];
  for (const step of timeline) {
    if (step.kind !== 'signal') continue;
    if (step.status !== 'pending' && step.status !== 'running') continue;
    tokens.push(step.name);
  }
  if (tokens.length === 0 && waiting && (waiting.on === 'signal' || waiting.on === 'webhook')) {
    tokens.push(waiting.name);
  }
  const seen = new Set<string>();
  const targets: WaitTarget[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const target = classifyWaitToken(token);
    if (target) targets.push(target);
  }
  return targets;
}

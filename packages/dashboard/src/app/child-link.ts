import type { RunDetail } from '../client/durable-client';

/**
 * If a timeline step represents a **child workflow**, return the child's run id so the graph can link
 * to it. Both child forms are encoded in the checkpoint name — no extra wire fields needed:
 *  - `ctx.startChild` (fire-and-forget) records `spawn:<childRunId>`.
 *  - `ctx.child` (awaited) resumes through the engine's `signal:<token>` checkpoint, with the token
 *    `child:<childRunId>` — i.e. `signal:child:<childRunId>`.
 *
 * Returns undefined for every other step (regular signals, webhooks, breakpoints, local/remote work).
 */
export function childRunIdOf(step: { name: string }): string | undefined {
  const SPAWN = 'spawn:';
  const AWAITED = 'signal:child:';
  if (step.name.startsWith(SPAWN)) return step.name.slice(SPAWN.length);
  if (step.name.startsWith(AWAITED)) return step.name.slice(AWAITED.length);
  return undefined;
}

/**
 * The most child runs a view fetches the detail of to label its child rows. Children past it show by
 * id: one request per child is a request storm on a wide fan.
 */
export const CHILD_DETAIL_LIMIT = 50;

/** The first `limit` distinct child run ids the timeline's steps refer to, in timeline order. */
export function childDetailIds(
  timeline: readonly { name: string }[],
  limit = CHILD_DETAIL_LIMIT,
): string[] {
  const ids = new Set<string>();
  for (const step of timeline) {
    if (ids.size >= limit) break;
    const id = childRunIdOf(step);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/**
 * A child row's label when its detail was not fetched (past the cap, or in a summarized fan): the
 * child's id without its parent's prefix (`all.1.w0.7`), so failed children stay tell-apart.
 */
export function childFallbackLabel(childRunId: string, parentRunId: string): string {
  const prefix = `${parentRunId}.`;
  return `child ${childRunId.startsWith(prefix) ? childRunId.slice(prefix.length) : childRunId}`;
}

/** The most child-run chips a run header lists before folding the rest into `+N more`. */
export const CHILD_CHIP_LIMIT = 12;

/**
 * The children a run header lists as chips, and how many more it has. `childCount` is the real total
 * when the server listed only the first of them.
 */
export function childChips(
  children: readonly string[],
  childCount: number | undefined,
  limit = CHILD_CHIP_LIMIT,
): { shown: string[]; more: number } {
  const shown = children.slice(0, limit);
  return { shown, more: Math.max(0, (childCount ?? children.length) - shown.length) };
}

/**
 * The settled child-run details of a `useQueries` over `['run', id]` keys, by run id. Passed as the
 * queries' `combine`: a module-level function, so the map keeps its identity until a detail changes
 * and a memo keyed on it holds.
 */
export function detailsById(
  results: readonly { data?: RunDetail | undefined }[],
): Record<string, RunDetail> {
  const map: Record<string, RunDetail> = {};
  for (const result of results) {
    if (result.data) map[result.data.run.id] = result.data;
  }
  return map;
}

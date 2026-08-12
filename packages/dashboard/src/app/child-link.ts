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

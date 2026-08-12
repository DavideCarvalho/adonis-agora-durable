/**
 * Lineage links derivable from a run id alone — no extra wire fields:
 *  - `ctx.child`/`ctx.startChild` name children `<parent>.child.<seq>` ⇒ parent link.
 *  - `retryWithInput` names the fresh run `<original>~retry~<hash>` ⇒ origin link.
 * A retried child composes both: `a.child.0~retry~x` → origin `a.child.0` → parent `a`.
 */
export function retryOriginOf(runId: string): string | undefined {
  const at = runId.lastIndexOf('~retry~');
  return at === -1 ? undefined : runId.slice(0, at);
}

export function parentRunIdOf(runId: string): string | undefined {
  // Strip retry suffixes first: the PARENT of `a.child.0~retry~x` is `a` (via its origin), not a
  // parse of the raw string. Then the last `.child.<seq>` segment names the parent prefix.
  const base = retryOriginOf(runId) ?? runId;
  const m = base.match(/^(.*)\.child\.\d+$/);
  return m?.[1] || undefined;
}

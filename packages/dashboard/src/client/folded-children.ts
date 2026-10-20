/**
 * A settled `ctx.all` group (a fan, or one wave of it) is folded by the engine into a single
 * `fan:<child id base>` checkpoint whose output holds the children's values. These read it as the
 * child runs it stands for, instead of showing its raw checkpoint name.
 */
const FOLDED_PREFIX = 'fan:';

/** How many child runs a folded checkpoint stands for, or undefined for any other step. */
export function foldedChildCount(step: { name: string; output?: unknown }): number | undefined {
  if (!step.name.startsWith(FOLDED_PREFIX)) return undefined;
  const values = (step.output as { values?: unknown } | null | undefined)?.values;
  return Array.isArray(values) ? values.length : undefined;
}

/** The name to show for a step: a folded group reads as its child-run count. */
export function stepDisplayName(step: { name: string; output?: unknown }): string {
  const count = foldedChildCount(step);
  if (count === undefined) return step.name;
  return `${count} child run${count === 1 ? '' : 's'}`;
}

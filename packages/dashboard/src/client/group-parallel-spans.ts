import type { StepCheckpoint } from './durable-client.js';

/**
 * A timeline rendered as a sequence of nodes: a plain `single` step, or a `fan` — N steps that the
 * engine tagged with the same `parallelGroup` (a `ctx.gather`/`ctx.all` fan-out, e.g. processing's 7
 * handlers) and that therefore ran as siblings, to be laid out at the same level rather than stacked.
 */
export type TimelineNode =
  | { kind: 'single'; step: StepCheckpoint }
  | { kind: 'fan'; group: string; steps: StepCheckpoint[]; label: string };

/** Longest shared leading word-ish prefix across names, trimmed of trailing separators. */
function commonPrefix(names: string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0] ?? '';
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  // Trim trailing separators (`handle_` → `handle`) so the label reads cleanly.
  return prefix.replace(/[\s._:-]+$/, '');
}

/** A concise summary of a fan: a name-derived label like `handle ×7` (NOT the group prefix). */
function fanLabel(steps: StepCheckpoint[]): string {
  const prefix = commonPrefix(steps.map((s) => s.name));
  // A single-character shared prefix (e.g. `a`/`b` → ``, but `fA`/`fB` → `f`) reads as noise, not a
  // meaningful label — fall back to `parallel` unless the shared prefix is at least two chars.
  return `${prefix.length >= 2 ? prefix : 'parallel'} ×${steps.length}`;
}

/**
 * Collapse consecutive steps that share a non-empty `parallelGroup` into one `fan` node (the engine
 * tags every sibling of one `ctx.gather`/`ctx.all` fan with the SAME exact group string — the
 * `gather:`/`all:` prefix is cosmetic, grouping is by exact string). A fan keeps its position where
 * its first member sat; input order is preserved. Steps with no `parallelGroup`, or a group of one,
 * stay `single`.
 */
export function groupParallelSpans(timeline: StepCheckpoint[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  let i = 0;
  while (i < timeline.length) {
    const step = timeline[i];
    if (step === undefined) {
      i += 1;
      continue;
    }
    const group = step.parallelGroup;
    if (group === undefined || group === '') {
      nodes.push({ kind: 'single', step });
      i += 1;
      continue;
    }
    // Gather the consecutive run of steps sharing this exact group.
    const steps: StepCheckpoint[] = [];
    let j = i;
    while (j < timeline.length && timeline[j]?.parallelGroup === group) {
      const s = timeline[j];
      if (s !== undefined) steps.push(s);
      j += 1;
    }
    if (steps.length <= 1) {
      // A lone member is not a fan — render it as an ordinary single row.
      nodes.push({ kind: 'single', step: steps[0] ?? step });
    } else {
      nodes.push({ kind: 'fan', group, steps, label: fanLabel(steps) });
    }
    i = j;
  }
  return nodes;
}

import type { FanSummary, StepCheckpoint } from './durable-client.js';
import { foldedChildCount } from './folded-children.js';

/**
 * A timeline rendered as a sequence of nodes: a plain `single` step, a `fan` — N steps that the
 * engine tagged with the same `parallelGroup` (a `ctx.gather`/`ctx.all` fan-out, e.g. processing's 7
 * handlers) and that therefore ran as siblings, to be laid out at the same level rather than stacked —
 * or a `summary`: a fan too wide for the detail to list, which the server sent as a {@link FanSummary}
 * with its members left out of the timeline.
 */
export type TimelineNode =
  | { kind: 'single'; step: StepCheckpoint }
  | { kind: 'fan'; group: string; steps: StepCheckpoint[]; label: string }
  | { kind: 'summary'; fan: FanSummary };

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

/** A concise summary of a fan: a name-derived label like `handle ×7` (NOT the group prefix). A
 *  `ctx.all` fan with folded waves counts the child runs each folded wave stands for. */
function fanLabel(steps: StepCheckpoint[]): string {
  if (steps.some((s) => foldedChildCount(s) !== undefined)) {
    const runs = steps.reduce((sum, s) => sum + (foldedChildCount(s) ?? 1), 0);
    return `child runs ×${runs}`;
  }
  const prefix = commonPrefix(steps.map((s) => s.name));
  // A single-character shared prefix (e.g. `a`/`b` → ``, but `fA`/`fB` → `f`) reads as noise, not a
  // meaningful label — fall back to `parallel` unless the shared prefix is at least two chars.
  return `${prefix.length >= 2 ? prefix : 'parallel'} ×${steps.length}`;
}

function firstSeqOf(node: TimelineNode): number {
  if (node.kind === 'single') return node.step.seq;
  if (node.kind === 'fan') return node.steps[0]?.seq ?? Number.POSITIVE_INFINITY;
  return node.fan.firstSeq;
}

/**
 * Collapse consecutive steps that share a non-empty `parallelGroup` into one `fan` node (the engine
 * tags every sibling of one `ctx.gather`/`ctx.all` fan with the SAME exact group string — the
 * `gather:`/`all:` prefix is cosmetic, grouping is by exact string). A fan keeps its position where
 * its first member sat; input order is preserved. Steps with no `parallelGroup`, or a group of one,
 * stay `single`.
 *
 * Each of `fans` becomes one `summary` node, placed where its first member would have sat: before the
 * first node whose first seq is past the fan's `firstSeq`.
 */
export function groupParallelSpans(
  timeline: StepCheckpoint[],
  fans: readonly FanSummary[] = [],
): TimelineNode[] {
  const nodes = groupSteps(timeline);
  if (fans.length === 0) return nodes;
  const pending = [...fans].sort((a, b) => a.firstSeq - b.firstSeq);
  const merged: TimelineNode[] = [];
  let f = 0;
  for (const node of nodes) {
    const seq = firstSeqOf(node);
    while (f < pending.length && (pending[f] as FanSummary).firstSeq < seq) {
      merged.push({ kind: 'summary', fan: pending[f] as FanSummary });
      f += 1;
    }
    merged.push(node);
  }
  for (; f < pending.length; f += 1)
    merged.push({ kind: 'summary', fan: pending[f] as FanSummary });
  return merged;
}

function groupSteps(timeline: StepCheckpoint[]): TimelineNode[] {
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

/**
 * A summarized fan's members by status, every status present. While its run is live, members not
 * started yet are `notStarted` (waves still to send). Once the run has finished, members still
 * `running`/`pending` are `interrupted` and the never-started ones `skipped`: a failFast fan that
 * stopped early, or a run cancelled mid-fan.
 */
export interface FanProgress {
  completed: number;
  failed: number;
  running: number;
  pending: number;
  interrupted: number;
  notStarted: number;
  skipped: number;
  /** Members started so far. */
  started: number;
  /** The fan's declared size, or `started` when its group does not carry one. */
  total: number;
}

export function fanProgress(fan: FanSummary, runFinished = false): FanProgress {
  const running = fan.counts.running ?? 0;
  const pending = fan.counts.pending ?? 0;
  const notStarted = fan.notStarted ?? 0;
  return {
    completed: fan.counts.completed ?? 0,
    failed: fan.counts.failed ?? 0,
    running: runFinished ? 0 : running,
    pending: runFinished ? 0 : pending,
    interrupted: runFinished ? running + pending : 0,
    notStarted: runFinished ? 0 : notStarted,
    skipped: runFinished ? notStarted : 0,
    started: fan.size,
    total: fan.total ?? fan.size,
  };
}

/** One status for a summarized fan's node: in flight while anything is left to run, else failed if
 *  any member failed or was cut short. */
export function fanStatus(fan: FanSummary, runFinished = false): StepCheckpoint['status'] {
  const p = fanProgress(fan, runFinished);
  if (p.running > 0) return 'running';
  if (p.pending > 0 || p.notStarted > 0) return 'pending';
  return p.failed > 0 || p.interrupted > 0 ? 'failed' : 'completed';
}

/** The fan's size as a node shows it: `×N`, or `started of N` while (or when) not all of it ran. */
export function fanSizeLabel(p: FanProgress): string {
  return p.started < p.total ? `${p.started} of ${p.total}` : `×${p.total}`;
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dead']);

/** A run is past its fans once it can no longer start or finish a member. */
export function runFinished(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

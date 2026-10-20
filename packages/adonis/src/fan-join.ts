import type { FanJoin, FanWait } from './errors.js';
import type { SignalWaiter } from './interfaces.js';

/**
 * Naming shared by `ctx.all` (which mints the ids) and the engine's join barrier (which reads them
 * back off a settling child's waiter). The child id and group are replay anchors: changing either
 * shape strands every run suspended on a fan.
 *
 * An unbounded fan names its children `<runId>.all.<firstSeq>.<i>`. A fan with a `concurrency` limit
 * dispatches in waves and puts the wave in the id, `<runId>.all.<firstSeq>.w<k>.<i>`, so the barrier
 * can wait on one wave at a time.
 */
export function allChildId(runId: string, firstSeq: number, index: number, wave?: number): string {
  return `${allBase(runId, firstSeq, wave)}${index}`;
}

/** The fan's `parallelGroup`. A failFast fan is marked so the barrier wakes it on the first failure. */
export function allGroup(firstSeq: number, mode: 'waitAll' | 'failFast'): string {
  return mode === 'failFast' ? `all:${firstSeq}:failFast` : `all:${firstSeq}`;
}

/** The waiter and checkpoint name prefixes shared by a fan's children, or one wave's. */
export function allWait(runId: string, firstSeq: number, wave?: number): FanWait {
  const base = allBase(runId, firstSeq, wave);
  return { waiterPrefix: `child:${base}`, checkpointPrefix: `signal:child:${base}` };
}

export function fanJoin(waits: FanWait[]): FanJoin {
  return { waits };
}

/**
 * A settled group of children (a fan, or one wave of it) folded into a single checkpoint:
 * `fan:<child id base>`, at the first child's seq. `values` are the children's outputs in input
 * order, starting at input index `from`.
 */
export const FOLDED_PREFIX = 'fan:';

export interface FoldedChildren {
  from: number;
  values: unknown[];
}

export function allFoldedName(runId: string, firstSeq: number, wave?: number): string {
  return `${FOLDED_PREFIX}${allBase(runId, firstSeq, wave)}`;
}

/** The child run ids a folded checkpoint stands for. */
export function foldedChildIds(checkpoint: { name: string; output?: unknown }): string[] {
  const base = checkpoint.name.slice(FOLDED_PREFIX.length);
  const folded = checkpoint.output as Partial<FoldedChildren> | null | undefined;
  if (!folded || !Array.isArray(folded.values) || typeof folded.from !== 'number') return [];
  const from = folded.from;
  return folded.values.map((_, j) => `${base}${from + j}`);
}

function allBase(runId: string, firstSeq: number, wave?: number): string {
  return wave === undefined ? `${runId}.all.${firstSeq}.` : `${runId}.all.${firstSeq}.w${wave}.`;
}

/**
 * How a fan of `size` children is dispatched under a `concurrency` limit: waves of `waveSize`, at
 * most `maxWaves` of them unsettled at once, so no more than `concurrency` children run together.
 * Half-size waves let the next wave start while the slowest children of the previous one finish.
 * Undefined when the limit does not bind, which keeps the unbounded fan's ids.
 */
export function allWaves(
  size: number,
  concurrency: number | undefined,
): { waveSize: number; maxWaves: number } | undefined {
  if (concurrency === undefined) return undefined;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`ctx.all: concurrency must be a positive integer, got ${concurrency}`);
  }
  if (concurrency >= size) return undefined;
  const waveSize = Math.ceil(concurrency / 2);
  return { waveSize, maxWaves: Math.floor(concurrency / waveSize) };
}

const ENGINE_CHILD_ID = /^(.+)\.(?:all\.\d+\.(?:w\d+\.)?\d+|child\.\d+)$/;

/**
 * The parent of a child run whose id the engine minted: a `ctx.all` child
 * (`<parent>.all.<seq>.<i>`, or `.w<k>.<i>` under a `concurrency` limit) or a `ctx.child` /
 * `ctx.startChild` child without an explicit id (`<parent>.child.<seq>`). Undefined for any other
 * run, including a child started with a caller-chosen id.
 */
export function parentRunIdOf(runId: string): string | undefined {
  return ENGINE_CHILD_ID.exec(runId)?.[1];
}

const GROUP = /^all:(\d+)(:failFast)?$/;
const REST = /^(?:w(\d+)\.)?\d+$/;

/**
 * The `ctx.all` fan (or, for a fan with a `concurrency` limit, the wave) a waiter belongs to, or
 * undefined for any other waiter (a lone `ctx.child`, a signal, a remote `gather_children`).
 * Requires the token and the group to agree, so a waiter that merely looks similar never holds back
 * a wake.
 */
export function fanOfWaiter(
  waiter: SignalWaiter,
): { waiterPrefix: string; failFast: boolean } | undefined {
  const group = waiter.parallelGroup ? GROUP.exec(waiter.parallelGroup) : null;
  if (!group) return undefined;
  const base = `child:${waiter.runId}.all.${group[1]}.`;
  if (!waiter.token.startsWith(base)) return undefined;
  const rest = REST.exec(waiter.token.slice(base.length));
  if (!rest) return undefined;
  const waiterPrefix = rest[1] === undefined ? base : `${base}w${rest[1]}.`;
  return { waiterPrefix, failFast: group[2] !== undefined };
}

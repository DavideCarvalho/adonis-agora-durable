import { FOLDED_PREFIX, type FoldedChildren, parentRunIdOf } from './fan-join.js';
import {
  type BufferedSignalRow,
  type StateStore,
  type StepCheckpoint,
  TERMINAL_RUN_STATUSES,
  type WorkflowRun,
} from './interfaces.js';
import { getRunsByIds } from './run-waiting.js';

/** The token a child's completion is signalled on: `child:<childRunId>`. */
export const CHILD_TOKEN_PREFIX = 'child:';

const CHILD_SIGNAL_NAME_PREFIX = 'signal:child:';

/** Terminal statuses a run can still leave (a retry), consuming its buffered completions. */
const RETRYABLE: ReadonlySet<string> = new Set(['failed', 'dead']);

/**
 * JSON with object keys sorted, so two completions compare equal whatever order their keys came
 * back in: MySQL's JSON type and Postgres `jsonb` do not keep insertion order. Through JSON first,
 * so a `Date` (anything with `toJSON`) compares as the string a column holds.
 */
export function canonicalJson(value: unknown): string {
  const plain = JSON.stringify(value);
  return plain === undefined ? 'null' : sortedJson(JSON.parse(plain));
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Where a parent records the settled outcome of `childId`: a `signal:child:<id>` checkpoint and, for
 * a `ctx.all` child, the `fan:<base>` checkpoint its fan (or wave) folds into. The id also says at
 * which `seq` each sits, which keeps these reads on the primary key and batched per parent: a read
 * by name costs one statement per child, and the sweep would send one per buffered row.
 *
 * - `<p>.all.<first>.<i>`: the signal at `first + i`, the fold at `first`.
 * - `<p>.all.<first>.w<k>.<i>`: the signal at `first + i`, the fold of wave `k` at `first + k * W`,
 *   where `W` (the wave size) is the length of wave 0's fold.
 * - `<p>.child.<n>`: the signal at `n`, unless `n` holds the `spawn:` of a `ctx.startChild`.
 * - anything else (an onError handler): no known seq.
 */
interface ChildSlot {
  signal: string;
  signalSeq?: number;
  fan?: { fold: string; firstSeq: number; index: number; wave?: number; waveZeroFold?: string };
}

const FAN_CHILD_PARTS = /^(.+\.all\.(\d+)\.)(?:w(\d+)\.)?(\d+)$/;
const SEQ_CHILD = /\.child\.(\d+)$/;

function slotOf(childId: string): ChildSlot {
  const signal = `${CHILD_SIGNAL_NAME_PREFIX}${childId}`;
  const fan = FAN_CHILD_PARTS.exec(childId);
  if (fan) {
    const root = fan[1] as string;
    const wave = fan[3];
    const firstSeq = Number(fan[2]);
    const index = Number(fan[4]);
    if (wave === undefined) {
      return {
        signal,
        signalSeq: firstSeq + index,
        fan: { fold: `${FOLDED_PREFIX}${root}`, firstSeq, index },
      };
    }
    return {
      signal,
      signalSeq: firstSeq + index,
      fan: {
        fold: `${FOLDED_PREFIX}${root}w${wave}.`,
        firstSeq,
        index,
        wave: Number(wave),
        waveZeroFold: `${FOLDED_PREFIX}${root}w0.`,
      },
    };
  }
  const seq = SEQ_CHILD.exec(childId);
  return seq ? { signal, signalSeq: Number(seq[1]) } : { signal };
}

/** A fold checkpoint's children, when `cp` is the completed fold `name`. */
function foldOf(cp: StepCheckpoint | undefined, name: string): FoldedChildren | undefined {
  if (cp?.status !== 'completed' || cp.name !== name) return undefined;
  const { from, values } = (cp.output ?? {}) as Partial<FoldedChildren>;
  return typeof from === 'number' && Array.isArray(values) ? { from, values } : undefined;
}

function covers(fold: FoldedChildren | undefined, index: number): boolean {
  return !!fold && index >= fold.from && index < fold.from + fold.values.length;
}

/** Whether `cp` is the completed signal checkpoint `signal` holding the same completion. */
function holdsSignal(cp: StepCheckpoint, signal: string, expected: string | undefined): boolean {
  return (
    expected !== undefined &&
    cp.status === 'completed' &&
    cp.name === signal &&
    canonicalJson(cp.output) === expected
  );
}

/** The completion as {@link canonicalJson}, or undefined for one JSON cannot hold (a BigInt, a cycle). */
function comparable(completion: unknown): string | undefined {
  try {
    return canonicalJson(completion);
  } catch {
    return undefined;
  }
}

/** The parent's checkpoints at `seqs`, by seq: one keyed read. */
async function checkpointsAt(
  store: StateStore,
  runId: string,
  seqs: readonly number[],
): Promise<Map<number, StepCheckpoint>> {
  const unique = [...new Set(seqs)];
  const bySeq = new Map<number, StepCheckpoint>();
  if (unique.length === 0) return bySeq;
  const rows = store.getCheckpoints
    ? await store.getCheckpoints(runId, unique)
    : (await Promise.all(unique.map((seq) => store.getCheckpoint(runId, seq)))).filter(
        (cp): cp is StepCheckpoint => cp !== null,
      );
  for (const cp of rows) bySeq.set(cp.seq, cp);
  return bySeq;
}

/** The parent's checkpoints named exactly one of `names`: the read by name, for ids with no seq. */
async function checkpointsNamed(
  store: StateStore,
  runId: string,
  names: readonly string[],
): Promise<StepCheckpoint[]> {
  const wanted = new Set(names);
  const rows = store.listCheckpointsByNamePrefix
    ? await store.listCheckpointsByNamePrefix(runId, [...wanted])
    : await store.listCheckpoints(runId);
  return rows.filter((cp) => wanted.has(cp.name));
}

/**
 * Which of `children` (with the completion each would deliver) `parentId` already settles: a
 * completed `signal:child:<id>` checkpoint holding the same completion, or a fold covering the child
 * (a fan folds only once every child in it settled). A few store calls whatever the number of
 * children: one keyed read for the seqs their ids name, one more for the folds of later waves of a
 * fan in waves, and a read by name only for the children whose seq says nothing (an onError
 * handler, a `ctx.startChild` child, a fan in waves whose wave 0 did not fold).
 */
async function parentSettles(
  store: StateStore,
  parentId: string,
  children: readonly { childId: string; completion: unknown }[],
): Promise<boolean[]> {
  const entries = children.map(({ childId, completion }) => ({
    slot: slotOf(childId),
    expected: comparable(completion),
  }));
  const held: (boolean | undefined)[] = entries.map(() => undefined);
  const first = await checkpointsAt(
    store,
    parentId,
    entries.flatMap(({ slot }) => [
      ...(slot.signalSeq === undefined ? [] : [slot.signalSeq]),
      ...(slot.fan ? [slot.fan.firstSeq] : []),
    ]),
  );
  const waveFolds: { at: number; seq: number }[] = [];
  const byName: number[] = [];
  entries.forEach(({ slot, expected }, at) => {
    const own = slot.signalSeq === undefined ? undefined : first.get(slot.signalSeq);
    if (own?.name === slot.signal) {
      held[at] = holdsSignal(own, slot.signal, expected);
      return;
    }
    const fan = slot.fan;
    if (fan) {
      // A fold sits at its first child's seq, so it can also be the one at the child's own seq.
      if (covers(foldOf(own, fan.fold), fan.index)) {
        held[at] = true;
        return;
      }
      const atFirst = first.get(fan.firstSeq);
      if (fan.wave === undefined || fan.wave === 0) {
        held[at] = covers(foldOf(atFirst, fan.fold), fan.index);
        return;
      }
      const waveZero = foldOf(atFirst, fan.waveZeroFold as string);
      if (waveZero && waveZero.values.length > 0) {
        waveFolds.push({ at, seq: fan.firstSeq + fan.wave * waveZero.values.length });
        return;
      }
      byName.push(at);
      return;
    }
    // A `.child.<n>` id with nothing at `n` has not been settled; a different name at `n` (the
    // `spawn:` of a `ctx.startChild`) means the signal is elsewhere.
    if (slot.signalSeq !== undefined && !own) {
      held[at] = false;
      return;
    }
    byName.push(at);
  });
  if (waveFolds.length > 0) {
    const second = await checkpointsAt(
      store,
      parentId,
      waveFolds.map((w) => w.seq),
    );
    for (const { at, seq } of waveFolds) {
      const fan = entries[at]?.slot.fan as NonNullable<ChildSlot['fan']>;
      held[at] = covers(foldOf(second.get(seq), fan.fold), fan.index);
    }
  }
  if (byName.length > 0) {
    const names = byName.flatMap((at) => {
      const { slot } = entries[at] as (typeof entries)[number];
      return slot.fan ? [slot.signal, slot.fan.fold] : [slot.signal];
    });
    const named = await checkpointsNamed(store, parentId, names);
    for (const at of byName) {
      const { slot, expected } = entries[at] as (typeof entries)[number];
      held[at] = named.some(
        (cp) =>
          holdsSignal(cp, slot.signal, expected) ||
          (!!slot.fan && covers(foldOf(cp, slot.fan.fold), slot.fan.index)),
      );
    }
  }
  return held.map((h) => h === true);
}

/** Whether `run` is gone, or terminal for good: nothing it could buffer for will ever be consumed. */
function parentClosed(run: WorkflowRun | null | undefined): boolean {
  return (
    !run ||
    ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status) &&
      !RETRYABLE.has(run.status))
  );
}

/**
 * Whether a child's completion that found no waiter must be buffered for its parent to consume
 * later. Only a parent consumes a `child:<id>` buffer, so the answer is no when:
 *
 * - the child's parent is unknown: a root run (started from a controller, a schedule), or a child
 *   whose id the caller chose. A parent awaiting a caller-chosen id puts its waiter before the child
 *   starts, so finding none means it is not waiting; a later join settles the child from its row;
 * - the parent is gone (pruned), or terminal for good (completed, cancelled; a `failed` or `dead`
 *   parent can still be retried, and its retry consumes the buffer);
 * - the parent already holds this outcome: a duplicate or late notification.
 *
 * It runs on every such completion of a wide fan, so it reads the parent's run row and its
 * checkpoints by key, never by name (except for an id that names no seq). A `parent` already read by
 * the caller can be passed to skip the run read (`null` = known missing). A completion JSON cannot
 * hold (a BigInt, a cycle) cannot be compared, and is kept for the parent.
 */
export async function childCompletionNeedsBuffer(
  store: StateStore,
  childId: string,
  completion: unknown,
  parent?: WorkflowRun | null,
): Promise<boolean> {
  const parentId = parentRunIdOf(childId);
  if (!parentId) return false;
  const run = parent === undefined ? await store.getRun(parentId) : parent;
  if (parentClosed(run)) return false;
  const [held] = await parentSettles(store, parentId, [{ childId, completion }]);
  return !held;
}

/** Read `ids` in batches; the ids of a batch that could not be read are reported, not guessed. */
async function readRuns(
  store: StateStore,
  ids: readonly string[],
): Promise<{ runs: Map<string, WorkflowRun>; unread: Set<string> }> {
  const unique = [...new Set(ids)];
  const runs = new Map<string, WorkflowRun>();
  const unread = new Set<string>();
  for (let at = 0; at < unique.length; at += 500) {
    const batch = unique.slice(at, at + 500);
    try {
      for (const [id, run] of await getRunsByIds(store, batch)) runs.set(id, run);
    } catch {
      for (const id of batch) unread.add(id);
    }
  }
  return { runs, unread };
}

/** What {@link unneededChildSignals} decided about a page of buffered signals. */
export interface BufferedSignalVerdict {
  /** The rows no parent will consume. */
  doomed: BufferedSignalRow[];
  /**
   * How many leading rows of the page are decided. Less than the page when the deadline passed
   * first; the rest are left for the next call.
   */
  decided: number;
}

/**
 * The `child:` buffered signals in `rows` no parent will ever consume (see
 * {@link childCompletionNeedsBuffer}), set-based: one read of every parent's run row, then for each
 * parent still open, one keyed read of its checkpoints covering all of its rows in the page. A row
 * whose parent or checkpoints could not be read is kept for the next pass. Once `deadline` (epoch
 * ms) passes, no further parent's checkpoints are read; the first always are, so every call makes
 * progress.
 */
export async function unneededChildSignals(
  store: StateStore,
  rows: readonly BufferedSignalRow[],
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<BufferedSignalVerdict> {
  const childOf = (row: BufferedSignalRow) =>
    row.token.startsWith(CHILD_TOKEN_PREFIX)
      ? row.token.slice(CHILD_TOKEN_PREFIX.length)
      : undefined;
  const parentIds = rows.flatMap((row) => {
    const childId = childOf(row);
    const parentId = childId === undefined ? undefined : parentRunIdOf(childId);
    return parentId ? [parentId] : [];
  });
  const { runs, unread } = await readRuns(store, parentIds);
  const doomed = new Set<BufferedSignalRow>();
  /** Rows to check against their parent's checkpoints, by parent, in page order. */
  const open = new Map<string, { at: number; row: BufferedSignalRow; childId: string }[]>();
  rows.forEach((row, at) => {
    const childId = childOf(row);
    if (childId === undefined) return;
    const parentId = parentRunIdOf(childId);
    if (!parentId) {
      doomed.add(row);
      return;
    }
    if (unread.has(parentId)) return;
    if (parentClosed(runs.get(parentId))) {
      doomed.add(row);
      return;
    }
    const group = open.get(parentId) ?? [];
    group.push({ at, row, childId });
    open.set(parentId, group);
  });
  let decided = rows.length;
  let checked = 0;
  for (const [parentId, group] of open) {
    if (checked > 0 && Date.now() >= deadline) {
      decided = (group[0] as (typeof group)[number]).at;
      break;
    }
    checked += 1;
    try {
      const held = await parentSettles(
        store,
        parentId,
        group.map(({ row, childId }) => ({ childId, completion: row.payload })),
      );
      group.forEach(({ row }, k) => {
        if (held[k]) doomed.add(row);
      });
    } catch {
      // A failed checkpoint read keeps the rows; the next pass decides.
    }
  }
  // Rows past the cut already doomed by their parent's run row alone go now too.
  return { doomed: rows.filter((row) => doomed.has(row)), decided };
}

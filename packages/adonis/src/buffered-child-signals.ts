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

/** A `ctx.all` child id: the fan's base (`<parent>.all.<seq>.` or `….w<k>.`) and its index. */
const FAN_CHILD = /^(.+\.all\.\d+\.(?:w\d+\.)?)(\d+)$/;

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

/** The checkpoint names under which a parent records the settled outcome of `childId`. */
function settledNames(childId: string): { signal: string; fold?: { name: string; index: number } } {
  const signal = `${CHILD_SIGNAL_NAME_PREFIX}${childId}`;
  const fan = FAN_CHILD.exec(childId);
  if (!fan) return { signal };
  return { signal, fold: { name: `${FOLDED_PREFIX}${fan[1]}`, index: Number(fan[2]) } };
}

/**
 * Whether `checkpoints` (the parent's) already settle `childId`: a completed `signal:child:<id>`
 * checkpoint holding the same completion, or a folded fan checkpoint covering the child (a fan
 * folds only once every child in it settled).
 */
function parentHoldsChild(
  checkpoints: readonly StepCheckpoint[],
  childId: string,
  completion: unknown,
): boolean {
  const { signal, fold } = settledNames(childId);
  const expected = canonicalJson(completion);
  return checkpoints.some((cp) => {
    if (cp.status !== 'completed') return false;
    if (cp.name === signal) return canonicalJson(cp.output) === expected;
    if (fold && cp.name === fold.name) {
      const { from, values } = (cp.output ?? {}) as Partial<FoldedChildren>;
      return (
        typeof from === 'number' &&
        Array.isArray(values) &&
        fold.index >= from &&
        fold.index < from + values.length
      );
    }
    return false;
  });
}

async function parentCheckpoints(
  store: StateStore,
  parentId: string,
  childId: string,
): Promise<StepCheckpoint[]> {
  const { signal, fold } = settledNames(childId);
  const prefixes = fold ? [signal, fold.name] : [signal];
  return store.listCheckpointsByNamePrefix
    ? store.listCheckpointsByNamePrefix(parentId, prefixes)
    : store.listCheckpoints(parentId);
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
 * A `parent` already read by the caller can be passed to skip the read (`null` = known missing).
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
  if (!run) return false;
  if (
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status) &&
    !RETRYABLE.has(run.status)
  ) {
    return false;
  }
  const checkpoints = await parentCheckpoints(store, parentId, childId);
  try {
    return !parentHoldsChild(checkpoints, childId, completion);
  } catch {
    // A completion JSON cannot hold (a BigInt, a cycle) cannot be compared: keep it for the parent.
    return true;
  }
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

/**
 * The `child:` buffered signals in `rows` no parent will ever consume (see
 * {@link childCompletionNeedsBuffer}). Parents are read in batches; a row whose parent could not be
 * read, or whose parent's checkpoints could not be read, is kept for the next pass.
 */
export async function unneededChildSignals(
  store: StateStore,
  rows: readonly BufferedSignalRow[],
): Promise<BufferedSignalRow[]> {
  const parentIds = rows.flatMap((row) => {
    const parentId = parentRunIdOf(row.token.slice(CHILD_TOKEN_PREFIX.length));
    return parentId ? [parentId] : [];
  });
  const { runs, unread } = await readRuns(store, parentIds);
  const doomed: BufferedSignalRow[] = [];
  for (const row of rows) {
    if (!row.token.startsWith(CHILD_TOKEN_PREFIX)) continue;
    const childId = row.token.slice(CHILD_TOKEN_PREFIX.length);
    const parentId = parentRunIdOf(childId);
    if (parentId && unread.has(parentId)) continue;
    const parent = parentId ? (runs.get(parentId) ?? null) : null;
    try {
      if (!(await childCompletionNeedsBuffer(store, childId, row.payload, parent))) {
        doomed.push(row);
      }
    } catch {
      // The next pass decides.
    }
  }
  return doomed;
}

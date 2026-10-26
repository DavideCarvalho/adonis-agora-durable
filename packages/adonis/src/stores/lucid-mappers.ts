import type {
  SignalWaiter,
  StepCheckpoint,
  StepError,
  StepEvent,
  StepSettlement,
  WorkflowRun,
} from '../interfaces.js';
import { normalizeNamespace } from '../namespaces.js';

/**
 * Row shapes as they live in the durable tables: snake_case columns, JSON payloads stored as TEXT
 * (we (de)serialize them here rather than relying on a driver's JSON column type, so the schema is
 * portable across SQLite / Postgres / MySQL). Timestamps are epoch-ms numbers.
 *
 * NOTE: drivers can return numeric columns as strings (e.g. `bigInteger` over some dialects) and
 * booleans/ints loosely typed, so every read goes through the guarded coercers below — never trust a
 * raw row field's static type.
 */
export interface RunRow {
  id: string;
  workflow: string;
  workflow_version: string;
  status: string;
  namespace: string | null;
  /** Nullable + optional: the column arrived in a later schema wave (origin attribution). */
  origin?: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  wake_at: number | string | null;
  locked_by: string | null;
  locked_until: number | string | null;
  recovery_attempts: number | string | null;
  tags: string | null;
  search_attributes: string | null;
  priority: number | string | null;
  /** Nullable + optional: the column arrived in a later schema wave (multi-instance remote decisions). */
  awaiting_decision_task_id?: string | null;
  /** Nullable + optional: the column arrived in a later schema wave (durable refused wakes). */
  wake_requested_at?: number | string | null;
  created_at: number | string;
  updated_at: number | string;
}

export interface CheckpointRow {
  run_id: string;
  seq: number | string;
  name: string;
  kind: string;
  step_id: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  events: string | null;
  attempts: number | string;
  worker_group: string | null;
  /** Nullable + optional: the column arrived in a later schema wave (durable flow-control release);
   *  rows selected on an un-migrated/older schema simply don't carry it. */
  queue?: string | null;
  wake_at: number | string | null;
  parallel_group: string | null;
  enqueued_at: number | string | null;
  started_at: number | string;
  finished_at: number | string;
  /** Nullable + optional: both columns arrived in a later schema wave (heartbeat persistence);
   *  rows selected on an un-migrated/older schema simply don't carry them. */
  last_heartbeat_at?: number | string | null;
  heartbeat_progress?: string | null;
}

/** Serialize an arbitrary payload to a TEXT column, preserving the "absent" distinction as NULL. */
function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

/** Where a column held text that is not JSON — see {@link parseJsonColumn}. */
export interface CorruptJsonColumn {
  /** `<table>.<column>`, e.g. `durable_step_checkpoints.events`. */
  column: string;
  /** The row's key: a run id, `runId#seq`, a schedule id, a buffered row id. */
  row: string;
  /** The parse error's message. */
  message: string;
}

/** Rows already reported, so a dashboard polling a broken run logs it once, not every 2 seconds. */
const reportedCorruptRows = new Set<string>();
const REPORTED_CORRUPT_ROWS_MAX = 1_000;

let corruptJsonReporter: (info: CorruptJsonColumn) => void = (info) => {
  console.warn(
    `@adonis-agora/durable: ${info.column} of row ${info.row} is not valid JSON (${info.message}); it reads back as undefined. A MySQL \`text\` column cut off at 64KB does this: the schema check widens the column to longtext, but a value cut off before that is lost.`,
  );
};

/**
 * Route the corrupt-column report of the Lucid store (default: one `console.warn` per row and
 * column) — to a logger or an error tracker; the store keeps reading either way. Returns the
 * previous reporter. Installing one resets the once-per-row memory.
 */
export function onCorruptJsonColumn(
  reporter: (info: CorruptJsonColumn) => void,
): (info: CorruptJsonColumn) => void {
  const previous = corruptJsonReporter;
  corruptJsonReporter = reporter;
  // A new sink hears about every damaged row, including ones the previous sink was told about.
  reportedCorruptRows.clear();
  return previous;
}

/**
 * Parse a TEXT JSON column back to its value, treating NULL as "absent". A value that is not JSON — a
 * MySQL `text` column cut off at 64KB before the schema used `longtext`, or a row edited by hand —
 * reads back as `undefined` and is reported once (see {@link onCorruptJsonColumn}) instead of
 * throwing: a throw here fails every read that touches the row, so one broken checkpoint used to take
 * down `listRuns`, the dashboard and the run detail, not just its own field.
 */
export function parseJsonColumn<T>(
  value: string | null | undefined,
  column: string,
  row: string,
): T | undefined {
  if (value == null) return undefined;
  // A driver may already hand back a parsed value (a native JSON column).
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    const key = `${column}\u0000${row}`;
    if (!reportedCorruptRows.has(key)) {
      if (reportedCorruptRows.size >= REPORTED_CORRUPT_ROWS_MAX) reportedCorruptRows.clear();
      reportedCorruptRows.add(key);
      try {
        corruptJsonReporter({
          column,
          row,
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* a reporter must not break the read it reports on */
      }
    }
    return undefined;
  }
}

const RUNS = 'durable_workflow_runs';
const CHECKPOINTS = 'durable_step_checkpoints';

/** Coerce a possibly-stringified numeric column (some drivers return bigints as strings) to a number. */
function toNum(value: number | string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isNaN(n) ? undefined : n;
}

/** Like {@link toNum} but for required columns — falls back to 0 if the driver hands back garbage. */
function toNumOr0(value: number | string | null | undefined): number {
  return toNum(value) ?? 0;
}

// --- runs -----------------------------------------------------------------

export function runToRow(run: WorkflowRun): RunRow {
  return {
    id: run.id,
    workflow: run.workflow,
    workflow_version: run.workflowVersion,
    status: run.status,
    // Persist the partition, defaulting an absent (or '') one to 'default' (matches the column
    // DEFAULT) so every default-pool row is reachable by a namespace='default' filter.
    namespace: normalizeNamespace(run.namespace),
    origin: run.origin ?? null,
    input: toJson(run.input),
    output: toJson(run.output),
    error: toJson(run.error),
    wake_at: run.wakeAt ?? null,
    locked_by: run.lockedBy ?? null,
    locked_until: run.lockedUntil ?? null,
    recovery_attempts: run.recoveryAttempts ?? null,
    tags: toJson(run.tags),
    search_attributes: toJson(run.searchAttributes),
    priority: run.priority ?? null,
    // Only when set: a fresh run never awaits a turn, and leaving the column out of the INSERT keeps
    // run creation working on a schema that predates it (`autoSchema: false`, migrations not re-run).
    ...(run.awaitingDecisionTaskId !== undefined
      ? { awaiting_decision_task_id: run.awaitingDecisionTaskId }
      : {}),
    created_at: run.createdAt.getTime(),
    updated_at: run.updatedAt.getTime(),
  };
}

/**
 * Map a run patch to a column patch using presence (`'x' in patch`) semantics for nullable fields, so
 * a patch can CLEAR a column (e.g. `{ error: undefined }` on completion → NULL), matching the
 * in-memory store's `{ ...existing, ...patch }` semantics. The two required Date fields use a
 * defined-guard since they're never cleared.
 */
export function runPatchToRow(patch: Partial<WorkflowRun>): Partial<RunRow> {
  const row: Partial<RunRow> = {};
  if ('workflow' in patch) row.workflow = patch.workflow;
  if ('workflowVersion' in patch) row.workflow_version = patch.workflowVersion;
  if ('status' in patch) row.status = patch.status;
  if ('namespace' in patch) row.namespace = normalizeNamespace(patch.namespace);
  if ('origin' in patch) row.origin = patch.origin ?? null;
  if ('input' in patch) row.input = toJson(patch.input);
  if ('output' in patch) row.output = toJson(patch.output);
  if ('error' in patch) row.error = toJson(patch.error);
  if ('wakeAt' in patch) row.wake_at = patch.wakeAt ?? null;
  if ('lockedBy' in patch) row.locked_by = patch.lockedBy ?? null;
  if ('lockedUntil' in patch) row.locked_until = patch.lockedUntil ?? null;
  if ('recoveryAttempts' in patch) row.recovery_attempts = patch.recoveryAttempts ?? null;
  if ('tags' in patch) row.tags = toJson(patch.tags);
  if ('searchAttributes' in patch) row.search_attributes = toJson(patch.searchAttributes);
  if ('priority' in patch) row.priority = patch.priority ?? null;
  if ('awaitingDecisionTaskId' in patch) {
    row.awaiting_decision_task_id = patch.awaitingDecisionTaskId ?? null;
  }
  if ('wakeRequestedAt' in patch) row.wake_requested_at = patch.wakeRequestedAt ?? null;
  if (patch.createdAt != null) row.created_at = patch.createdAt.getTime();
  if (patch.updatedAt != null) row.updated_at = patch.updatedAt.getTime();
  return row;
}

export function rowToRun(row: RunRow): WorkflowRun {
  const run: WorkflowRun = {
    id: row.id,
    workflow: row.workflow,
    workflowVersion: row.workflow_version,
    status: row.status as WorkflowRun['status'],
    input: parseJsonColumn(row.input, `${RUNS}.input`, row.id),
    namespace: normalizeNamespace(row.namespace),
    createdAt: new Date(toNumOr0(row.created_at)),
    updatedAt: new Date(toNumOr0(row.updated_at)),
  };
  const output = parseJsonColumn(row.output, `${RUNS}.output`, row.id);
  if (output !== undefined) run.output = output;
  const error = parseJsonColumn<StepError>(row.error, `${RUNS}.error`, row.id);
  if (error !== undefined) run.error = error;
  const wakeAt = toNum(row.wake_at);
  if (wakeAt !== undefined) run.wakeAt = wakeAt;
  if (row.origin != null) run.origin = row.origin;
  if (row.locked_by != null) run.lockedBy = row.locked_by;
  const lockedUntil = toNum(row.locked_until);
  if (lockedUntil !== undefined) run.lockedUntil = lockedUntil;
  const recoveryAttempts = toNum(row.recovery_attempts);
  if (recoveryAttempts !== undefined) run.recoveryAttempts = recoveryAttempts;
  const tags = parseJsonColumn<string[]>(row.tags, `${RUNS}.tags`, row.id);
  if (tags !== undefined) run.tags = tags;
  const searchAttributes = parseJsonColumn<WorkflowRun['searchAttributes']>(
    row.search_attributes,
    `${RUNS}.search_attributes`,
    row.id,
  );
  if (searchAttributes !== undefined) run.searchAttributes = searchAttributes;
  const priority = toNum(row.priority);
  if (priority !== undefined) run.priority = priority;
  if (row.awaiting_decision_task_id != null) {
    run.awaitingDecisionTaskId = row.awaiting_decision_task_id;
  }
  const wakeRequestedAt = toNum(row.wake_requested_at ?? null);
  if (wakeRequestedAt !== undefined) run.wakeRequestedAt = wakeRequestedAt;
  return run;
}

// --- checkpoints ----------------------------------------------------------

export function checkpointToRow(cp: StepCheckpoint): CheckpointRow {
  return {
    run_id: cp.runId,
    seq: cp.seq,
    name: cp.name,
    kind: cp.kind,
    step_id: cp.stepId,
    status: cp.status,
    input: toJson(cp.input),
    output: toJson(cp.output),
    error: toJson(cp.error),
    events: toJson(cp.events),
    attempts: cp.attempts,
    worker_group: cp.workerGroup ?? null,
    queue: cp.queue ?? null,
    wake_at: cp.wakeAt ?? null,
    parallel_group: cp.parallelGroup ?? null,
    enqueued_at: (cp.enqueuedAt ?? cp.startedAt).getTime(),
    started_at: cp.startedAt.getTime(),
    finished_at: cp.finishedAt.getTime(),
  };
}

/** The checkpoint columns a {@link StepSettlement} writes, by column name. */
export const SETTLED_CHECKPOINT_COLUMNS = [
  'status',
  'output',
  'error',
  'events',
  'started_at',
  'finished_at',
] as const;

export function settlementToRow(
  s: StepSettlement,
): Pick<CheckpointRow, (typeof SETTLED_CHECKPOINT_COLUMNS)[number]> {
  return {
    status: s.status,
    output: toJson(s.output),
    error: toJson(s.error),
    events: toJson(s.events),
    started_at: s.startedAt.getTime(),
    finished_at: s.finishedAt.getTime(),
  };
}

/** Every checkpoint column but `input`, the one a completed step's replay never reads. */
export const CHECKPOINT_COLUMNS_BUT_INPUT = [
  'run_id',
  'seq',
  'name',
  'kind',
  'step_id',
  'status',
  'output',
  'error',
  'events',
  'attempts',
  'worker_group',
  'queue',
  'wake_at',
  'parallel_group',
  'enqueued_at',
  'started_at',
  'finished_at',
  'last_heartbeat_at',
  'heartbeat_progress',
] as const;

export function rowToCheckpoint(row: CheckpointRow): StepCheckpoint {
  const key = `${row.run_id}#${row.seq}`;
  const cp: StepCheckpoint = {
    runId: row.run_id,
    seq: toNumOr0(row.seq),
    name: row.name,
    kind: row.kind as StepCheckpoint['kind'],
    stepId: row.step_id,
    status: row.status as StepCheckpoint['status'],
    input: parseJsonColumn(row.input, `${CHECKPOINTS}.input`, key),
    attempts: toNumOr0(row.attempts),
    enqueuedAt: new Date(toNum(row.enqueued_at) ?? toNumOr0(row.started_at)),
    startedAt: new Date(toNumOr0(row.started_at)),
    finishedAt: new Date(toNumOr0(row.finished_at)),
  };
  const output = parseJsonColumn(row.output, `${CHECKPOINTS}.output`, key);
  if (output !== undefined) cp.output = output;
  const error = parseJsonColumn<StepError>(row.error, `${CHECKPOINTS}.error`, key);
  if (error !== undefined) cp.error = error;
  const events = parseJsonColumn<StepEvent[]>(row.events, `${CHECKPOINTS}.events`, key);
  if (events !== undefined) cp.events = events;
  if (row.worker_group != null) cp.workerGroup = row.worker_group;
  if (row.queue != null) cp.queue = row.queue;
  const wakeAt = toNum(row.wake_at);
  if (wakeAt !== undefined) cp.wakeAt = wakeAt;
  if (row.parallel_group != null) cp.parallelGroup = row.parallel_group;
  const lastHeartbeatAt = toNum(row.last_heartbeat_at);
  if (lastHeartbeatAt !== undefined) cp.lastHeartbeatAt = new Date(lastHeartbeatAt);
  const heartbeatProgress = parseJsonColumn(
    row.heartbeat_progress,
    `${CHECKPOINTS}.heartbeat_progress`,
    key,
  );
  if (heartbeatProgress !== undefined) cp.heartbeatProgress = heartbeatProgress;
  return cp;
}

// --- signal waiters -------------------------------------------------------

/** Map a `durable_signal_waiters` row back to a {@link SignalWaiter}, omitting a null fan group. */
export function rowToSignalWaiter(row: {
  token: string;
  run_id: string;
  seq: number | string;
  parallel_group?: unknown;
}): SignalWaiter {
  const waiter: SignalWaiter = { token: row.token, runId: row.run_id, seq: toNumOr0(row.seq) };
  if (row.parallel_group != null) waiter.parallelGroup = String(row.parallel_group);
  return waiter;
}

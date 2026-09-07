import type {
  SignalWaiter,
  StepCheckpoint,
  StepError,
  StepEvent,
  WorkflowRun,
} from '../interfaces.js';

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

/** Parse a TEXT JSON column back to its value, treating NULL/empty as "absent". */
function fromJson<T>(value: string | null): T | undefined {
  if (value == null) return undefined;
  return JSON.parse(value) as T;
}

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
    // Persist the partition, defaulting an absent one to 'default' (matches the column DEFAULT) so
    // every row is reachable by a namespace='default' filter.
    namespace: run.namespace ?? 'default',
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
  if ('namespace' in patch) row.namespace = patch.namespace ?? 'default';
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
    input: fromJson(row.input),
    namespace: row.namespace ?? 'default',
    createdAt: new Date(toNumOr0(row.created_at)),
    updatedAt: new Date(toNumOr0(row.updated_at)),
  };
  const output = fromJson(row.output);
  if (output !== undefined) run.output = output;
  const error = fromJson<StepError>(row.error);
  if (error !== undefined) run.error = error;
  const wakeAt = toNum(row.wake_at);
  if (wakeAt !== undefined) run.wakeAt = wakeAt;
  if (row.locked_by != null) run.lockedBy = row.locked_by;
  const lockedUntil = toNum(row.locked_until);
  if (lockedUntil !== undefined) run.lockedUntil = lockedUntil;
  const recoveryAttempts = toNum(row.recovery_attempts);
  if (recoveryAttempts !== undefined) run.recoveryAttempts = recoveryAttempts;
  const tags = fromJson<string[]>(row.tags);
  if (tags !== undefined) run.tags = tags;
  const searchAttributes = fromJson<WorkflowRun['searchAttributes']>(row.search_attributes);
  if (searchAttributes !== undefined) run.searchAttributes = searchAttributes;
  const priority = toNum(row.priority);
  if (priority !== undefined) run.priority = priority;
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

export function rowToCheckpoint(row: CheckpointRow): StepCheckpoint {
  const cp: StepCheckpoint = {
    runId: row.run_id,
    seq: toNumOr0(row.seq),
    name: row.name,
    kind: row.kind as StepCheckpoint['kind'],
    stepId: row.step_id,
    status: row.status as StepCheckpoint['status'],
    input: fromJson(row.input),
    attempts: toNumOr0(row.attempts),
    enqueuedAt: new Date(toNum(row.enqueued_at) ?? toNumOr0(row.started_at)),
    startedAt: new Date(toNumOr0(row.started_at)),
    finishedAt: new Date(toNumOr0(row.finished_at)),
  };
  const output = fromJson(row.output);
  if (output !== undefined) cp.output = output;
  const error = fromJson<StepError>(row.error);
  if (error !== undefined) cp.error = error;
  const events = fromJson<StepEvent[]>(row.events);
  if (events !== undefined) cp.events = events;
  if (row.worker_group != null) cp.workerGroup = row.worker_group;
  if (row.queue != null) cp.queue = row.queue;
  const wakeAt = toNum(row.wake_at);
  if (wakeAt !== undefined) cp.wakeAt = wakeAt;
  if (row.parallel_group != null) cp.parallelGroup = row.parallel_group;
  const lastHeartbeatAt = toNum(row.last_heartbeat_at);
  if (lastHeartbeatAt !== undefined) cp.lastHeartbeatAt = new Date(lastHeartbeatAt);
  const heartbeatProgress = fromJson(row.heartbeat_progress ?? null);
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

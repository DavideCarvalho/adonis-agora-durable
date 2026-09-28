import { parseDuration } from './duration.js';
import type { StartOptions } from './engine.js';
import type {
  RunResult,
  RunStatus,
  ScheduleQuery,
  ScheduleRecord,
  SearchAttributes,
  StateStore,
  WorkflowRun,
} from './interfaces.js';
import { nextCronFireMs, prevCronFireMs } from './scheduler.js';
import { type WorkflowRef, workflowName } from './workflow-ref.js';

/** Statuses a run never leaves on its own — an `overlap: 'skip'` schedule may fire again. */
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled', 'dead'];

/**
 * A schedule definition — what `engine.schedules.create/upsert` take. Temporal-style: a persisted,
 * runtime-managed recurring start of `workflow` with `input`, fired by every driving engine's timer
 * poll (safe with many workers: each window's run id is deterministic, `start` is idempotent, and
 * advancing the schedule is a compare-and-set).
 */
export interface ScheduleOptions {
  /** Stable id, unique per store (e.g. `digest:user-42`). Part of every run id it starts. */
  id: string;
  /** The workflow to start — a registered name or `@Workflow` class. */
  workflow: WorkflowRef;
  /** The input every run starts with. */
  input?: unknown;
  /** Cron expression (5 fields, or 6 with leading seconds). Needs the `cron-parser` peer. */
  cron?: string | undefined;
  /** Fixed interval (`'15m'`, or ms), windows aligned to the epoch. Exclusive with `cron`. */
  every?: string | number | undefined;
  /** IANA timezone the cron is evaluated in (e.g. `America/Sao_Paulo`). Default UTC. */
  timezone?: string | undefined;
  /**
   * Delay each fire by up to this much (`'30s'` or ms) — a stable per-(schedule, window) offset, so
   * thousands of schedules on the same cron don't all start in the same second.
   */
  jitter?: string | number | undefined;
  /**
   * The previous run of this schedule is still in flight when the next window comes due:
   * `'allow'` (default) starts the new one anyway; `'skip'` skips that window.
   */
  overlap?: 'allow' | 'skip' | undefined;
  /**
   * Windows missed while nothing polled (all schedulers down): `'latest'` (default) fires the most
   * recent missed window once; `'skip'` drops them and waits for the next window. Never more than one
   * catch-up run per schedule.
   */
  catchup?: 'latest' | 'skip' | undefined;
  /** Create paused (never due until `resume`). On `upsert`, omit to keep the current paused state. */
  paused?: boolean | undefined;
  /** Free-form note shown with the schedule (why it exists / why it's paused). */
  note?: string | undefined;
  /** Namespace of the schedule and of the runs it starts. Defaults to the engine's own namespace. */
  namespace?: string | undefined;
  /** Labels to find the schedule by — also stamped on every run it starts (plus `schedule:<id>`). */
  tags?: string[] | undefined;
  /** Search attributes stamped on every run it starts. */
  searchAttributes?: SearchAttributes | undefined;
  /** Dispatch priority for the runs it starts. */
  priority?: number | undefined;
}

/** A schedule as `engine.schedules.get/list` describe it. */
export interface ScheduleDescription {
  id: string;
  workflow: string;
  input: unknown;
  namespace: string;
  cron?: string | undefined;
  everyMs?: number | undefined;
  timezone?: string | undefined;
  jitterMs?: number | undefined;
  overlap: 'allow' | 'skip';
  catchup: 'latest' | 'skip';
  paused: boolean;
  note?: string | undefined;
  tags?: string[] | undefined;
  searchAttributes?: SearchAttributes | undefined;
  priority?: number | undefined;
  /** When it is next due (jitter included), or null if it never fires again / paused. */
  nextFireAt: Date | null;
  /** The last window it fired for, and the run that window started. */
  lastFireAt?: Date | undefined;
  lastRunId?: string | undefined;
  /** How many windows it has fired (manual triggers excluded). */
  fires: number;
  /** The last start failure (e.g. a concurrency limit), cleared by the next successful start. */
  lastError?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
}

/** Filter for `engine.schedules.list`. */
export type ScheduleListQuery = Omit<ScheduleQuery, 'dueBy'>;

/** Thrown by `engine.schedules.create` when the id is taken (use `upsert` to replace). */
export class ScheduleAlreadyExistsError extends Error {
  constructor(readonly scheduleId: string) {
    super(`schedule "${scheduleId}" already exists`);
    this.name = 'ScheduleAlreadyExistsError';
  }
}

/** Thrown by `engine.schedules.*` on an id that doesn't exist. */
export class ScheduleNotFoundError extends Error {
  constructor(readonly scheduleId: string) {
    super(`schedule "${scheduleId}" not found`);
    this.name = 'ScheduleNotFoundError';
  }
}

/** The persisted definition (`ScheduleRecord.spec`). Versioned so the shape can evolve. */
interface SpecDoc {
  v: 1;
  input?: unknown;
  cron?: string;
  everyMs?: number;
  timezone?: string;
  jitterMs?: number;
  overlap: 'allow' | 'skip';
  catchup: 'latest' | 'skip';
  note?: string;
  searchAttributes?: SearchAttributes;
  priority?: number;
}

/** The persisted bookkeeping (`ScheduleRecord.state`). */
interface StateDoc {
  /** The nominal window `nextFireAt` belongs to (nextFireAt = window + jitter). */
  window?: number | null | undefined;
  lastFireAt?: number | undefined;
  lastRunId?: string | undefined;
  fires?: number | undefined;
  lastError?: string | undefined;
}

/** The engine surface the schedule client drives. */
export interface ScheduleHost {
  start(workflow: string, input: unknown, runId: string, opts?: StartOptions): Promise<RunResult>;
  getRun(runId: string): Promise<WorkflowRun | null>;
}

/** Engine-level knobs for the client. */
export interface ScheduleClientOptions {
  /** The engine's namespace: the default for new schedules, and which ones `tick` fires. */
  namespace?: string | undefined;
  clock?: (() => number) | undefined;
}

const DEFAULT_NAMESPACE = 'default';
/** How late a window may fire under `catchup: 'skip'` and still count as on time (plus jitter). */
const ON_TIME_GRACE_MS = 60_000;
const TICK_BATCH = 100;

/**
 * Persisted, runtime-managed schedules — `engine.schedules`. Unlike the code-registered
 * `schedules` config / `static schedule`, these live in the store: create/update/pause/delete them at runtime
 * (one per user, per tenant, per automation…), and every driving engine's timer poll fires the due
 * ones via {@link tick}.
 *
 * Multi-worker safety comes from two properties, not from a lock: a window's run id is deterministic
 * (`sched:<id>:<windowMs>`), so racing starts of the same window collapse into one run; and a
 * schedule is advanced with a compare-and-set on its `nextFireAt`, so exactly one poller moves it on.
 * A crash between starting the run and advancing the schedule just re-fires the (idempotent) start.
 */
export class ScheduleClient {
  constructor(
    private readonly store: StateStore,
    private readonly host: ScheduleHost,
    private readonly options: ScheduleClientOptions = {},
  ) {}

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }

  /** Whether the store persists schedules (implements the schedule methods). */
  get supported(): boolean {
    const s = this.store;
    return !!(
      s.saveSchedule &&
      s.getSchedule &&
      s.updateSchedule &&
      s.deleteSchedule &&
      s.listSchedules
    );
  }

  private requireStore(): Required<
    Pick<
      StateStore,
      'saveSchedule' | 'getSchedule' | 'updateSchedule' | 'deleteSchedule' | 'listSchedules'
    >
  > {
    if (!this.supported) {
      throw new Error(
        'persisted schedules need a store that implements saveSchedule/getSchedule/updateSchedule/deleteSchedule/listSchedules — every bundled store adapter does; this one does not',
      );
    }
    const s = this.store;
    return {
      saveSchedule: (r) => (s.saveSchedule as NonNullable<StateStore['saveSchedule']>).call(s, r),
      getSchedule: (id) => (s.getSchedule as NonNullable<StateStore['getSchedule']>).call(s, id),
      updateSchedule: (id, patch, expected) =>
        (s.updateSchedule as NonNullable<StateStore['updateSchedule']>).call(
          s,
          id,
          patch,
          expected,
        ),
      deleteSchedule: (id) =>
        (s.deleteSchedule as NonNullable<StateStore['deleteSchedule']>).call(s, id),
      listSchedules: (q) =>
        (s.listSchedules as NonNullable<StateStore['listSchedules']>).call(s, q),
    };
  }

  /** Create a schedule. Throws {@link ScheduleAlreadyExistsError} if the id is taken. */
  async create(opts: ScheduleOptions): Promise<ScheduleDescription> {
    const store = this.requireStore();
    if (await store.getSchedule(opts.id)) throw new ScheduleAlreadyExistsError(opts.id);
    return this.write(opts, null);
  }

  /**
   * Create the schedule, or replace the definition of an existing one (its history — last fire, last
   * run, fire count — is kept). The next fire is recomputed from now under the new definition, so a
   * window that already fired is never fired again by an upsert.
   */
  async upsert(opts: ScheduleOptions): Promise<ScheduleDescription> {
    const store = this.requireStore();
    return this.write(opts, await store.getSchedule(opts.id));
  }

  /** The schedule `id`, or null. */
  async get(id: string): Promise<ScheduleDescription | null> {
    const record = await this.requireStore().getSchedule(id);
    return record ? describe(record) : null;
  }

  /** Schedules matching `query`, soonest-due first. */
  async list(query: ScheduleListQuery = {}): Promise<ScheduleDescription[]> {
    return (await this.requireStore().listSchedules(query)).map(describe);
  }

  /** Delete the schedule. Runs it already started are left alone. Returns whether it existed. */
  delete(id: string): Promise<boolean> {
    return this.requireStore().deleteSchedule(id);
  }

  /** Stop firing until {@link resume}. `note` records why (shown by `get`/`list`). */
  async pause(id: string, note?: string): Promise<ScheduleDescription> {
    const store = this.requireStore();
    const record = await this.mustGet(id);
    const spec = { ...(record.spec as unknown as SpecDoc) };
    if (note !== undefined) spec.note = note;
    await store.updateSchedule(id, {
      paused: true,
      spec: spec as unknown as Record<string, unknown>,
      updatedAt: new Date(this.now()),
    });
    return describe(await this.mustGet(id));
  }

  /**
   * Fire again from the next window after now — the windows skipped while paused are NOT caught up.
   */
  async resume(id: string): Promise<ScheduleDescription> {
    const store = this.requireStore();
    const record = await this.mustGet(id);
    const spec = record.spec as unknown as SpecDoc;
    const window = nextWindowAfter(spec, this.now());
    await store.updateSchedule(id, {
      paused: false,
      nextFireAt: window === null ? null : window + jitterFor(record.id, window, spec),
      state: { ...record.state, window } as Record<string, unknown>,
      updatedAt: new Date(this.now()),
    });
    return describe(await this.mustGet(id));
  }

  /**
   * Start one run of the schedule right now, outside its cadence (paused or not). The run id is
   * `sched:<id>:manual:<nowMs>`; it doesn't move the schedule's next fire.
   */
  async trigger(id: string): Promise<RunResult> {
    const record = await this.mustGet(id);
    const runId = `sched:${id}:manual:${this.now()}`;
    return this.host.start(record.workflow, specOf(record).input, runId, startOptions(record));
  }

  /**
   * Fire every due schedule (in this engine's namespace; all namespaces for an operator engine):
   * start its window's run and advance it to the next window. Called by the worker tick (`durable:work`
   * / the embedded worker) when `persistedSchedules` is on; call it yourself from any other driver.
   * Returns the
   * run ids started (or re-found, for an idempotent re-fire).
   */
  async tick(nowMs: number = this.now()): Promise<string[]> {
    const store = this.requireStore();
    const started: string[] = [];
    for (let round = 0; round < 50; round++) {
      const due = await store.listSchedules({
        dueBy: nowMs,
        namespace: this.options.namespace,
        limit: TICK_BATCH,
      });
      for (const record of due) {
        const runId = await this.fire(record, nowMs);
        if (runId) started.push(runId);
      }
      if (due.length < TICK_BATCH) break;
    }
    return started;
  }

  /** Fire one due schedule and advance it. Returns the run id started, if any. */
  private async fire(record: ScheduleRecord, nowMs: number): Promise<string | undefined> {
    const store = this.requireStore();
    const spec = specOf(record);
    const state = record.state as StateDoc;
    let latest: number;
    let next: number | null;
    try {
      // The most recent window at or before now — the one (and only one) a late poll fires.
      latest = latestWindowAtOrBefore(spec, nowMs);
      next = nextWindowAfter(spec, latest);
    } catch (error) {
      // A definition that no longer evaluates (bad cron/timezone): stop it, loudly, instead of
      // failing on every tick forever.
      await store.updateSchedule(
        record.id,
        {
          paused: true,
          nextFireAt: null,
          state: { ...state, lastError: `invalid schedule: ${errorMessage(error)}` },
          updatedAt: new Date(nowMs),
        },
        record.nextFireAt,
      );
      return undefined;
    }
    const window = state.window ?? latest;
    const jitter = spec.jitterMs ?? 0;
    const onTime = nowMs - latest <= ON_TIME_GRACE_MS + jitter;
    let runId: string | undefined;
    let lastError: string | undefined;
    let fired = false;
    const skipMissed = spec.catchup === 'skip' && !onTime;
    const beforeWindow = latest < window; // clock skew: not actually due yet
    if (!skipMissed && !beforeWindow && !(await this.overlapping(spec, state))) {
      runId = `sched:${record.id}:${latest}`;
      try {
        await this.host.start(record.workflow, spec.input, runId, startOptions(record));
        fired = true;
      } catch (error) {
        // A racing poller may have created the same (deterministic) run first: that's a success.
        if (await this.host.getRun(runId)) fired = true;
        else lastError = errorMessage(error);
      }
    }
    const nextState: StateDoc = {
      ...state,
      window: next,
      ...(fired ? { lastFireAt: latest, lastRunId: runId, fires: (state.fires ?? 0) + 1 } : {}),
      lastError: fired ? undefined : (lastError ?? state.lastError),
    };
    await store.updateSchedule(
      record.id,
      {
        nextFireAt: next === null ? null : next + jitterFor(record.id, next, spec),
        state: stripUndefined(nextState) as Record<string, unknown>,
        updatedAt: new Date(nowMs),
      },
      record.nextFireAt,
    );
    return fired ? runId : undefined;
  }

  /** `overlap: 'skip'` and the previous run of this schedule is still in flight. */
  private async overlapping(spec: SpecDoc, state: StateDoc): Promise<boolean> {
    if (spec.overlap !== 'skip' || !state.lastRunId) return false;
    const prev = await this.host.getRun(state.lastRunId);
    return !!prev && !TERMINAL_RUN_STATUSES.includes(prev.status as RunStatus);
  }

  private async mustGet(id: string): Promise<ScheduleRecord> {
    const record = await this.requireStore().getSchedule(id);
    if (!record) throw new ScheduleNotFoundError(id);
    return record;
  }

  private async write(
    opts: ScheduleOptions,
    existing: ScheduleRecord | null,
  ): Promise<ScheduleDescription> {
    const store = this.requireStore();
    const spec = toSpec(opts);
    const now = this.now();
    // An upsert that doesn't say otherwise keeps a paused schedule paused.
    const paused = opts.paused ?? existing?.paused ?? false;
    const window = nextWindowAfter(spec, now); // also validates the cron/timezone up front
    const record: ScheduleRecord = {
      id: opts.id,
      namespace: opts.namespace ?? this.options.namespace ?? DEFAULT_NAMESPACE,
      workflow: workflowName(opts.workflow),
      paused,
      nextFireAt: window === null ? null : window + jitterFor(opts.id, window, spec),
      tags: opts.tags,
      spec: spec as unknown as Record<string, unknown>,
      state: stripUndefined({
        ...((existing?.state as StateDoc | undefined) ?? {}),
        window,
      }) as Record<string, unknown>,
      createdAt: existing?.createdAt ?? new Date(now),
      updatedAt: new Date(now),
    };
    await store.saveSchedule(record);
    return describe(record);
  }
}

function toSpec(opts: ScheduleOptions): SpecDoc {
  if ((opts.cron == null) === (opts.every == null)) {
    throw new Error(`schedule "${opts.id}" needs exactly one of "cron" or "every"`);
  }
  const everyMs = opts.every != null ? parseDuration(opts.every) : undefined;
  if (everyMs !== undefined && !(everyMs > 0)) {
    throw new Error(`schedule "${opts.id}": "every" must be a positive duration`);
  }
  const jitterMs = opts.jitter != null ? parseDuration(opts.jitter) : undefined;
  return stripUndefined({
    v: 1 as const,
    input: opts.input,
    cron: opts.cron,
    everyMs,
    timezone: opts.timezone,
    jitterMs: jitterMs && jitterMs > 0 ? jitterMs : undefined,
    overlap: opts.overlap ?? 'allow',
    catchup: opts.catchup ?? 'latest',
    note: opts.note,
    searchAttributes: opts.searchAttributes,
    priority: opts.priority,
  }) as SpecDoc;
}

function specOf(record: ScheduleRecord): SpecDoc {
  return record.spec as unknown as SpecDoc;
}

/** The latest window at or before `atMs`. */
function latestWindowAtOrBefore(spec: SpecDoc, atMs: number): number {
  if (spec.cron != null) return prevCronFireMs(spec.cron, atMs, spec.timezone);
  const every = spec.everyMs as number;
  return Math.floor(atMs / every) * every;
}

/** The first window strictly after `afterMs`. */
function nextWindowAfter(spec: SpecDoc, afterMs: number): number | null {
  if (spec.cron != null) return nextCronFireMs(spec.cron, afterMs, spec.timezone);
  const every = spec.everyMs as number;
  return (Math.floor(afterMs / every) + 1) * every;
}

/** A stable offset in `[0, jitterMs)` per (schedule, window): FNV-1a over the pair. */
function jitterFor(id: string, window: number, spec: SpecDoc): number {
  const max = spec.jitterMs ?? 0;
  if (max <= 0) return 0;
  let h = 0x811c9dc5;
  for (const ch of `${id}@${window}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % max;
}

function startOptions(record: ScheduleRecord): StartOptions {
  const spec = specOf(record);
  return stripUndefined({
    tags: [...(record.tags ?? []), `schedule:${record.id}`],
    namespace: record.namespace,
    searchAttributes: spec.searchAttributes,
    priority: spec.priority,
  }) as StartOptions;
}

function describe(record: ScheduleRecord): ScheduleDescription {
  const spec = specOf(record);
  const state = record.state as StateDoc;
  return stripUndefined({
    id: record.id,
    workflow: record.workflow,
    input: spec.input,
    namespace: record.namespace,
    cron: spec.cron,
    everyMs: spec.everyMs,
    timezone: spec.timezone,
    jitterMs: spec.jitterMs,
    overlap: spec.overlap ?? 'allow',
    catchup: spec.catchup ?? 'latest',
    paused: record.paused,
    note: spec.note,
    tags: record.tags,
    searchAttributes: spec.searchAttributes,
    priority: spec.priority,
    nextFireAt: record.paused || record.nextFireAt == null ? null : new Date(record.nextFireAt),
    lastFireAt: state.lastFireAt != null ? new Date(state.lastFireAt) : undefined,
    lastRunId: state.lastRunId,
    fires: state.fires ?? 0,
    lastError: state.lastError,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }) as ScheduleDescription;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

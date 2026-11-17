import type { RunResult, WorkflowEngine } from '../index.js';
import { withScheduleOrigin } from '../observability-scope.js';
import {
  nextScheduleFireAt,
  resolveSchedule,
  runSchedules,
  type ScheduledWorkflow,
} from '../scheduler.js';

/** A minimal logger the worker loop writes progress to (the ace command's `this.logger` fits). */
export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * Run one tick of the worker poll loop against the engine: pick up enqueued runs, recover runs left
 * incomplete by a crash, resume runs whose durable timers are due, cancel runs past their execution
 * timeout, and finally fire any due `schedules` (the 5th phase — see {@link TickOptions.schedules}).
 * Returns a per-phase count of the runs each phase touched — the unit the `durable:work` command logs
 * and the tests assert on. Each phase is awaited independently so one phase throwing does not abort the
 * rest of the tick (the error is collected and surfaced). The buffered-signal sweep is started, not
 * awaited: it runs beside the tick, one at a time, and a failure of it is reported by the next tick.
 */
export interface TickResult {
  pending: number;
  recovered: number;
  timers: number;
  /** Run ids the schedules phase started this tick (due windows fired). */
  scheduled: number;
  /** Terminal runs (subtrees included) the retention phase deleted this tick — 0 without a policy. */
  evicted: number;
  /** Phase errors caught during the tick (e.g. a transient store hiccup), keyed by phase name. */
  errors: { phase: string; error: Error }[];
}

/** Per-tick inputs beyond the engine. */
export interface TickOptions {
  /** Logical "now" (epoch ms) for the tick — passed to each phase. Defaults to the real clock. */
  now?: number;
  /**
   * Recurring schedules fired after timeouts are swept (the 5th phase). `engine.start` is idempotent
   * by each schedule's time-bucket run id, so racing workers start every window exactly once. Empty
   * or undefined skips the phase entirely.
   */
  schedules?: readonly ScheduledWorkflow[];
}

/**
 * Merge the schedules declared in `config/durable.ts` → `schedules` with those discovered from
 * workflow classes' `static schedule` (colocation). **Config wins on a key collision**: a config entry
 * is an explicit, reviewed declaration and overrides a colocated schedule that shares its `key`
 * (the colocated one is dropped so the window isn't double-registered). Config schedules come first,
 * then the surviving discovered ones. A schedule whose `workflow` is a class comes back with its
 * registered name, and a class with no `static workflow = { name }` throws here, so the worker fails
 * to start instead of failing on every tick. Pure — the command wires it, the tests assert on it.
 */
export function mergeSchedules(
  configSchedules: readonly ScheduledWorkflow[],
  discovered: readonly ScheduledWorkflow[],
): ScheduledWorkflow<string>[] {
  const resolved = configSchedules.map(resolveSchedule);
  const configKeys = new Set(resolved.map((s) => s.key));
  const surviving = discovered.filter((s) => !configKeys.has(s.key)).map(resolveSchedule);
  return [...resolved, ...surviving];
}

const settledCount = (results: RunResult[]): number => results.length;

/**
 * How often a worker reads the settled runs that still owe a lifecycle event. It is the recovery
 * path for a publish that never happened (the live publish gets a 30s grace first), and the read
 * filters on a tag no index serves, so doing it on every 1s tick scanned the runs table each second.
 */
export const OWED_LIFECYCLE_SWEEP_INTERVAL_MS = 10_000;

const owedSweptAt = new WeakMap<WorkflowEngine, number>();

/**
 * Whether this tick reads the owed runs: until a sweep that read them succeeds, then once per
 * interval (a clock that goes back reads them again).
 */
function owedSweepDue(engine: WorkflowEngine, now: number | undefined): boolean {
  const at = now ?? Date.now();
  const last = owedSweptAt.get(engine);
  return !(last !== undefined && at >= last && at - last < OWED_LIFECYCLE_SWEEP_INTERVAL_MS);
}

/** Execute a single poll-loop tick. See {@link TickResult}. Never throws — phase errors are collected. */
export async function runTick(
  engine: WorkflowEngine,
  options: TickOptions = {},
): Promise<TickResult> {
  // Everything a tick does is scheduler-driven. Labelling the whole tick means the
  // entries an observability tool records for the work it PICKS UP say where they came
  // from ("a schedule fired this", not the `manual` default that told you nothing). The
  // probe reads inside the engine mark themselves separately, as heartbeat, and are
  // dropped — see `observability-scope.ts` for why those are two different questions.
  return withScheduleOrigin(() => runTickInScope(engine, options));
}

async function runTickInScope(engine: WorkflowEngine, options: TickOptions): Promise<TickResult> {
  const now = options.now;
  const schedules = options.schedules;
  // Let the engine's runtime schedule-control surface (list/pause/trigger) see the exact set that
  // fires — including a console-issued pause applying to the very next tick.
  if (schedules) engine.adoptSchedules(schedules);
  const result: TickResult = {
    pending: 0,
    recovered: 0,
    timers: 0,
    scheduled: 0,
    evicted: 0,
    errors: [],
  };
  const phase = async (name: string, fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch (error) {
      result.errors.push({ phase: name, error: toError(error) });
      return 0;
    }
  };
  result.pending = await phase('runPending', async () =>
    settledCount(await engine.runPending(now)),
  );
  result.recovered = await phase('recoverIncomplete', async () =>
    settledCount(await engine.recoverIncomplete(now)),
  );
  result.timers = await phase('resumeDueTimers', async () =>
    settledCount(await engine.resumeDueTimers(now)),
  );
  await phase('sweepTimeouts', async () => {
    await engine.sweepTimeouts(now);
    return 0;
  });
  // Lifecycle events a settled run still owes (its process died before publishing). A no-op
  // without lifecycle subscribers.
  const owed = owedSweepDue(engine, now);
  await phase('sweepLifecycleEvents', async () => {
    const published = await engine.sweepLifecycleEvents(now, undefined, { owed });
    // Only a sweep that got through starts the interval: a failed one is retried on the next tick.
    if (owed) owedSweptAt.set(engine, now ?? Date.now());
    return published;
  });
  // Buffered child completions nothing will consume: a bounded slice per tick, self-throttled
  // between full passes. Housekeeping, so it runs beside the tick instead of inside it.
  startBufferedSweep(engine, now, result);
  // 5th phase — fire any due recurring schedules (mirrors the NestJS timer poller). Skipped entirely
  // when none are registered; idempotent by the schedule's time-bucket run id, so racing workers
  // start each window exactly once.
  result.scheduled = await phase('runSchedules', async () => {
    if (!schedules || schedules.length === 0) return 0;
    const ids = await runSchedules(engine, schedules, now ?? Date.now());
    return ids.length;
  });
  // …and the PERSISTED schedules (`engine.schedules`), when `persistedSchedules` is on: one indexed
  // "due by now" query; each window's run id is deterministic and advancing is a compare-and-set, so
  // racing workers start every window exactly once.
  result.scheduled += await phase('runPersistedSchedules', async () =>
    engine.persistedSchedulesEnabled ? (await engine.schedules.tick(now)).length : 0,
  );
  // 6th phase — retention: evict terminal runs past their configured age. Self-throttled inside the
  // engine (one pass a minute); a no-op without a `retention` config.
  result.evicted = await phase('sweepRetention', async () => engine.sweepRetention(now));
  // 7th phase — stalled detection: page onStalled listeners about stranded runs. Self-throttled
  // inside the engine (one pass a minute); a no-op without listeners.
  await phase('sweepStalled', async () => (await engine.sweepStalled(now)).length);
  // 8th phase — entity lost-wake reconcile: wake entities whose ops sit in their buffer with no wake
  // coming (a process died between storing an op and waking its entity). Self-throttled (once a
  // minute); a no-op on a store that cannot list buffered tokens.
  await phase('sweepEntityWakes', async () => engine.sweepEntityWakes(now));
  return result;
}

/** Per engine: the buffered-signal sweep a tick started that has not finished, and its failure. */
const bufferedSweeps = new WeakMap<
  WorkflowEngine,
  { running: Promise<void> | undefined; failed: Error | undefined }
>();

/**
 * Start `engine.sweepBufferedSignals` unless the one a previous tick started is still running, and
 * report into `result` the failure of one that ended since the last tick.
 */
function startBufferedSweep(
  engine: WorkflowEngine,
  now: number | undefined,
  result: TickResult,
): void {
  let state = bufferedSweeps.get(engine);
  if (!state) {
    state = { running: undefined, failed: undefined };
    bufferedSweeps.set(engine, state);
  }
  const sweep = state;
  if (sweep.failed) {
    result.errors.push({ phase: 'sweepBufferedSignals', error: sweep.failed });
    sweep.failed = undefined;
  }
  if (sweep.running) return;
  sweep.running = Promise.resolve()
    .then(() => engine.sweepBufferedSignals(now))
    .then(
      () => {
        sweep.running = undefined;
      },
      (error: unknown) => {
        sweep.running = undefined;
        sweep.failed = toError(error);
      },
    );
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * `wait`, cut short so the next tick runs no later than the earliest known due time: the engine's
 * next timer, wake request or persisted schedule, and the next window of `options.schedules`. Never
 * below `intervalMs` (the regular tick catches what is due sooner). A failed read keeps the regular tick.
 */
async function untilDue(
  engine: WorkflowEngine,
  options: WorkerLoopOptions,
  wait: number,
): Promise<number> {
  try {
    const now = Date.now();
    const stored = await engine.nextDueAt();
    const scheduled = options.schedules?.length
      ? nextScheduleFireAt(engine, options.schedules, now)
      : undefined;
    let due = wait;
    for (const at of [stored, scheduled]) {
      if (at !== undefined) due = Math.min(due, at - Date.now());
    }
    return Math.max(options.intervalMs, due);
  } catch {
    return options.intervalMs;
  }
}

/** Options for {@link runWorkerLoop}. */
export interface WorkerLoopOptions {
  /** Poll interval in ms between ticks. */
  intervalMs: number;
  /** Resolves/rejects to stop the loop gracefully (wired to SIGINT/SIGTERM by the command). */
  stopSignal: Promise<void>;
  logger: WorkerLogger;
  /**
   * Total shutdown budget in ms, from the stop request: the wait for the tick still in flight plus
   * `engine.drain`. Time spent waiting for the tick is deducted from the drain. Default 10s.
   */
  drainTimeoutMs?: number;
  /** Injectable sleep, for tests. Default a real timer that resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
  /** Recurring schedules to fire each tick (the 5th phase). See {@link TickOptions.schedules}. */
  schedules?: readonly ScheduledWorkflow[];
  /**
   * The longest wait (ms) between two ticks while the worker is idle. After a tick that found
   * nothing to do the wait doubles from `intervalMs` up to this, and goes back to `intervalMs` as soon
   * as there is work. It never outlasts a known due time (the next timer, wake request or schedule
   * window, read before each longer wait), and ends at once when another instance enqueues a run
   * (control-plane nudge) or a run starts or finishes a turn here. Recovery of a crashed instance's
   * runs and execution timeouts are picked up at most this late. A value at or below `intervalMs`
   * keeps the fixed tick; so does an engine that cannot be woken (see
   * `WorkflowEngine.idleBackoffSupported`). Default {@link DEFAULT_MAX_IDLE_INTERVAL_MS}.
   */
  maxIdleIntervalMs?: number;
}

/** Default {@link WorkerLoopOptions.maxIdleIntervalMs}: an idle worker ticks every 5 s at most. */
export const DEFAULT_MAX_IDLE_INTERVAL_MS = 5_000;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

/**
 * The long-running worker loop: tick, then wait `intervalMs` (or until `stopSignal` resolves),
 * repeat. On stop it drains in-flight executions so a deploy hands off cleanly. Returns the number of
 * ticks executed — testable by resolving `stopSignal` after N ticks with an injected `sleep`.
 */
export async function runWorkerLoop(
  engine: WorkflowEngine,
  options: WorkerLoopOptions,
): Promise<number> {
  const sleep = options.sleep ?? realSleep;
  // THIS process is a worker: flush consumer subscriptions a deferred transport parked at boot
  // (see Transport.deferConsumers) — without this, a worker booted in a console environment would
  // poll the store but never claim broker jobs.
  engine.startConsumers();
  const drainTimeoutMs = options.drainTimeoutMs ?? 10_000;
  let stopped = false;
  let stoppedAt = 0;
  // Resolves `drainTimeoutMs` after the stop request: the most a tick still in flight is waited for.
  let budgetSpent!: () => void;
  const outOfBudget = new Promise<'timeout'>((resolve) => {
    budgetSpent = () => resolve('timeout');
  });
  void options.stopSignal.then(() => {
    stopped = true;
    stoppedAt = Date.now();
    // Stop picking up new runs inside the tick that is still running; drain still waits for it.
    engine.beginDrain();
    const t = setTimeout(budgetSpent, drainTimeoutMs);
    (t as { unref?: () => void }).unref?.();
  });
  // Idle backoff: `wait` grows while ticks find nothing, and a wake-up ends the current wait.
  const maxIdle = options.maxIdleIntervalMs ?? DEFAULT_MAX_IDLE_INTERVAL_MS;
  const backoff = maxIdle > options.intervalMs && engine.idleBackoffSupported;
  let wait = options.intervalMs;
  let activity = false;
  let wake: (() => void) | undefined;
  const unsubscribe = backoff
    ? engine.onIdleWake((reason) => {
        activity = true;
        // `activity` ends only a wait longer than the regular tick; `work` ends any wait.
        if (reason === 'work' || wait > options.intervalMs) wake?.();
      })
    : undefined;
  let ticks = 0;
  while (!stopped) {
    // Work that arrived during the wait (it ended the wait) counts as this tick's: one regular tick
    // follows before the loop backs off again.
    const arrived = activity;
    activity = false;
    const tick = runTick(engine, options.schedules ? { schedules: options.schedules } : {});
    const result = await Promise.race([tick, outOfBudget]);
    if (result === 'timeout') {
      // The tick outlived the whole shutdown budget: stop waiting for it (drain gets nothing left).
      options.logger.error(
        `tick still running ${drainTimeoutMs}ms after the stop request; stopping without waiting for it`,
      );
      break;
    }
    ticks += 1;
    const touched = result.pending + result.recovered + result.timers + result.scheduled;
    if (touched > 0) {
      options.logger.info(
        `tick: ${result.pending} pending, ${result.recovered} recovered, ${result.timers} timers, ${result.scheduled} scheduled`,
      );
    }
    for (const { phase, error } of result.errors) {
      options.logger.error(`tick phase ${phase} failed: ${error.message}`);
    }
    if (stopped) break;
    const idle = touched === 0 && result.errors.length === 0 && !activity && !arrived;
    wait = backoff && idle ? Math.min(wait * 2, maxIdle) : options.intervalMs;
    if (wait > options.intervalMs) wait = await untilDue(engine, options, wait);
    // Race the wait against the stop signal (and, while idle, a wake-up) so shutdown is prompt.
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    if (activity && wait > options.intervalMs) wake?.(); // something happened during the read
    await Promise.race([sleep(wait), options.stopSignal.catch(() => undefined), woken]);
    wake = undefined;
  }
  unsubscribe?.();
  // A sweep still running beside the last tick stops at its next page (the engine is draining); wait
  // for it within the same budget, so the store is not closed under it.
  const sweep = bufferedSweeps.get(engine);
  if (sweep?.running && stoppedAt > 0) {
    if ((await Promise.race([sweep.running, outOfBudget])) === 'timeout') {
      options.logger.error(
        `buffered-signal sweep still running ${drainTimeoutMs}ms after the stop request; draining without waiting for it`,
      );
    }
  }
  // No tick follows to report a failure of the last sweep.
  if (sweep?.failed) {
    options.logger.error(`tick phase sweepBufferedSignals failed: ${sweep.failed.message}`);
    sweep.failed = undefined;
  }
  // Charge the drain for the time already spent waiting on the in-flight tick, so the stop request
  // to the end of the drain stays within ONE `drainTimeoutMs`.
  if (stoppedAt > 0) engine.beginDrain(Date.now() - stoppedAt);
  options.logger.info(`draining (timeout ${drainTimeoutMs}ms)…`);
  await engine.drain(drainTimeoutMs);
  options.logger.info(`worker stopped after ${ticks} ticks`);
  return ticks;
}

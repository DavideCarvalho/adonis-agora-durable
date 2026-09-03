import type { RunResult, WorkflowEngine } from '../index.js';
import { withScheduleOrigin } from '../observability-scope.js';
import { runSchedules, type ScheduledWorkflow } from '../scheduler.js';

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
 * rest of the tick (the error is collected and surfaced).
 */
export interface TickResult {
  pending: number;
  recovered: number;
  timers: number;
  /** Run ids the schedules phase started this tick (due windows fired). */
  scheduled: number;
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
 * then the surviving discovered ones. Pure — the command wires it, the tests assert on it.
 */
export function mergeSchedules(
  configSchedules: readonly ScheduledWorkflow[],
  discovered: readonly ScheduledWorkflow[],
): ScheduledWorkflow[] {
  const configKeys = new Set(configSchedules.map((s) => s.key));
  const surviving = discovered.filter((s) => !configKeys.has(s.key));
  return [...configSchedules, ...surviving];
}

const settledCount = (results: RunResult[]): number => results.length;

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
  const result: TickResult = { pending: 0, recovered: 0, timers: 0, scheduled: 0, errors: [] };
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
  // 5th phase — fire any due recurring schedules (mirrors the NestJS timer poller). Skipped entirely
  // when none are registered; idempotent by the schedule's time-bucket run id, so racing workers
  // start each window exactly once.
  result.scheduled = await phase('runSchedules', async () => {
    if (!schedules || schedules.length === 0) return 0;
    const ids = await runSchedules(engine, schedules, now ?? Date.now());
    return ids.length;
  });
  return result;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Options for {@link runWorkerLoop}. */
export interface WorkerLoopOptions {
  /** Poll interval in ms between ticks. */
  intervalMs: number;
  /** Resolves/rejects to stop the loop gracefully (wired to SIGINT/SIGTERM by the command). */
  stopSignal: Promise<void>;
  logger: WorkerLogger;
  /** Drain timeout passed to `engine.drain` on shutdown. Default 10s. */
  drainTimeoutMs?: number;
  /** Injectable sleep, for tests. Default a real timer that resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
  /** Recurring schedules to fire each tick (the 5th phase). See {@link TickOptions.schedules}. */
  schedules?: readonly ScheduledWorkflow[];
}

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
  let stopped = false;
  void options.stopSignal.then(() => {
    stopped = true;
  });
  let ticks = 0;
  while (!stopped) {
    const result = await runTick(engine, options.schedules ? { schedules: options.schedules } : {});
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
    // Race the interval against the stop signal so shutdown is prompt, not interval-latent.
    await Promise.race([sleep(options.intervalMs), options.stopSignal.catch(() => undefined)]);
  }
  options.logger.info(`draining (timeout ${options.drainTimeoutMs ?? 10_000}ms)…`);
  await engine.drain(options.drainTimeoutMs);
  options.logger.info(`worker stopped after ${ticks} ticks`);
  return ticks;
}

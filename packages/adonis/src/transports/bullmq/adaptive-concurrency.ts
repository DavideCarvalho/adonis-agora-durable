import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import type { WorkerAdjust, WorkerStatus } from '../../interfaces.js';

/**
 * The adaptive controller's tunables — every field optional, each with a default from the spec.
 * Spread under `{ mode: 'adaptive' }` to widen a plain `concurrency: number` into a self-tuning knob.
 */
export interface AdaptiveConcurrencyOptions {
  /** Floor the controller won't go below. Default 1. */
  min?: number;
  /** Ceiling the controller won't exceed. Default 32. */
  max?: number;
  /** Initial limit. Default `min` (clamped into `[min,max]`). */
  start?: number;
  /** RSS percent of the memory ceiling at which the hard brake fires. Default 85. */
  ramCeilingPct?: number;
  /** CPU percent (0..100×cores normalised to 0..100) ceiling; absent = off. Default undefined. */
  cpuCeilingPct?: number;
  /** Control-loop period in ms. Default 2000. */
  tickMs?: number;
}

/**
 * The `concurrency` option, widened (backward-compatible): a plain `number` is fixed (unchanged), the
 * string `'adaptive'` is adaptive-with-defaults, and an object `{ mode:'adaptive', ... }` is adaptive
 * with overrides. `undefined` keeps the historical default of 1 (fixed).
 */
export type ConcurrencyOption =
  | number
  | 'adaptive'
  | ({ mode: 'adaptive' } & AdaptiveConcurrencyOptions);

/** The fully-resolved adaptive tunables (every default applied), carried on a resolved config. */
export interface AdaptiveConfig {
  min: number;
  max: number;
  start: number;
  ramCeilingPct: number;
  cpuCeilingPct?: number;
  tickMs: number;
}

/** A normalised `concurrency` option: a `fixed` number, or an `adaptive` config with every default applied. */
export interface ResolvedConcurrency {
  mode: 'fixed' | 'adaptive';
  /** Present when `mode === 'fixed'` — the never-moving concurrency. */
  fixed?: number;
  /** Present when `mode === 'adaptive'` — the controller's tunables. */
  adaptive?: AdaptiveConfig;
}

const DEFAULT_MIN = 1;
const DEFAULT_MAX = 32;
const DEFAULT_RAM_CEILING_PCT = 85;
const DEFAULT_TICK_MS = 2000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** `value` floored when it is a finite number of at least 1, else `fallback`. */
function wholeAtLeastOne(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** `value` when it is a finite number above 0, else `fallback`. */
function finitePositive<T>(value: number | undefined, fallback: T): number | T {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Normalise a {@link ConcurrencyOption} into a {@link ResolvedConcurrency}: a bare number (or
 * `undefined` → 1) becomes `{ mode:'fixed', fixed }`; `'adaptive'` / `{ mode:'adaptive', ... }`
 * become `{ mode:'adaptive', adaptive }` with every default from the spec applied and `start`
 * clamped into `[min,max]`.
 *
 * A non-finite or out-of-range number falls back to its default (a bad `cpuCeilingPct` turns the
 * CPU ceiling off): BullMQ throws on a `NaN` or sub-1 concurrency, a `NaN` ceiling never brakes, and
 * a `NaN` `tickMs` makes the control loop fire every millisecond.
 */
export function resolveConcurrency(opt?: ConcurrencyOption): ResolvedConcurrency {
  if (opt === undefined) return { mode: 'fixed', fixed: 1 };
  if (typeof opt === 'number') return { mode: 'fixed', fixed: wholeAtLeastOne(opt, 1) };

  const overrides: AdaptiveConcurrencyOptions = opt === 'adaptive' ? {} : opt;
  const min = wholeAtLeastOne(overrides.min, DEFAULT_MIN);
  const max = Math.max(min, wholeAtLeastOne(overrides.max, DEFAULT_MAX));
  const start = clamp(wholeAtLeastOne(overrides.start, min), min, max);
  const cpuCeilingPct = finitePositive(overrides.cpuCeilingPct, undefined);
  const adaptive: AdaptiveConfig = {
    min,
    max,
    start,
    ramCeilingPct: finitePositive(overrides.ramCeilingPct, DEFAULT_RAM_CEILING_PCT),
    tickMs: wholeAtLeastOne(overrides.tickMs, DEFAULT_TICK_MS),
    ...(cpuCeilingPct !== undefined ? { cpuCeilingPct } : {}),
  };
  return { mode: 'adaptive', adaptive };
}

// The cgroup "unlimited" sentinel: a limit at/above this is no real cap, so fall through to host total.
const CGROUP_UNLIMITED = 2 ** 62;

/**
 * The process memory ceiling in bytes, read once (cgroup limits don't move at runtime): cgroup v2
 * `memory.max`, then cgroup v1 `memory.limit_in_bytes`, then the host total. A `max` / absurdly-large
 * ("unlimited") cgroup value falls through to {@link totalmem}. No new deps — just `node:fs`/`node:os`.
 */
export function readMemoryLimitBytes(): number {
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (raw && raw !== 'max') {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < CGROUP_UNLIMITED) return n;
    }
  } catch {
    /* not cgroup v2 (or unreadable) — try v1 next */
  }
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0 && n < CGROUP_UNLIMITED) return n;
  } catch {
    /* not cgroup v1 (or unreadable) — fall through to host total */
  }
  return totalmem();
}

/** A single completed task's record kept in the rolling window. */
interface Completion {
  durationMs: number;
  ok: boolean;
  at: number;
}

// How many recent completions the controller reasons over (latency percentiles + throughput + errors).
const WINDOW_SIZE = 100;
// EWMA smoothing for the "no-queuing" baseline (rttLong): low weight so a single fast sample doesn't
// reset the baseline, but it still tracks a genuine floor shift.
const RTT_LONG_EWMA_ALPHA = 0.2;
// Consecutive ticks with in-flight work but zero completions before we call the worker stalled.
const STALL_TICKS = 2;
// Throughput is a rate over the trailing minute: a window whose newest completion is older than this
// reports 0, so an idle worker never advertises its last burst as live.
const THROUGHPUT_WINDOW_MS = 60_000;
// The shortest span a rate is computed over, so a worker's first completion doesn't extrapolate a
// sub-millisecond gap into a huge per-minute figure.
const THROUGHPUT_MIN_SPAN_MS = 1_000;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = clamp(Math.ceil((p / 100) * sortedAsc.length) - 1, 0, sortedAsc.length - 1);
  return sortedAsc[idx] ?? 0;
}

/** Construction surface for {@link AdaptiveController}. */
export interface AdaptiveControllerOptions {
  /** The raw `concurrency` option (resolved internally). */
  concurrency?: ConcurrencyOption;
  /**
   * Applied whenever the live limit changes — wire it to `worker.concurrency = limit`. Called once
   * with the initial limit is NOT done here; the caller passes the initial limit to the Worker ctor
   * and reads {@link AdaptiveController.limit}. Subsequent adaptive moves call this.
   */
  apply?: (limit: number) => void;
  /** Injectable clock (tests). Defaults to {@link Date.now}. */
  now?: () => number;
  /** Injectable RSS reader (tests). Defaults to `process.memoryUsage().rss`. */
  readRss?: () => number;
  /** Injectable memory-ceiling reader (tests). Defaults to {@link readMemoryLimitBytes} (read once). */
  readMemoryLimit?: () => number;
  /** Injectable cumulative CPU-time reader (tests). Defaults to `process.cpuUsage()`. */
  readCpuUsage?: () => NodeJS.CpuUsage;
  /** Injectable core-count reader (tests), read once. Defaults to `os.cpus().length`. */
  readCpuCount?: () => number;
}

/**
 * A single gradient-limit (AIMD) concurrency controller, shared by every per-routing-token task
 * worker of one {@link import('./bullmq-transport.js').BullMQTransport}. It tracks in-flight work and a rolling window of
 * completions, and — in `adaptive` mode — re-evaluates the worker's concurrency every `tickMs` from a
 * latency gradient, an error/stall backpressure signal, a hard RAM brake and an optional CPU ceiling.
 *
 * In `fixed` mode no control loop runs and the limit never moves, but the controller still tracks
 * `inFlight`/RSS/throughput/p95 (and samples CPU when a snapshot is taken) so the observability half
 * (the heartbeat status payload) works without adaptive. Either way, {@link snapshot} returns the
 * shared {@link WorkerStatus} contract the heartbeat writer stamps.
 */
export class AdaptiveController {
  private readonly resolved: ResolvedConcurrency;
  private readonly apply: (limit: number) => void;
  private readonly now: () => number;
  private readonly readRss: () => number;
  private readonly memoryLimitBytes: number;
  private readonly tickMs: number;
  private readonly readCpuUsage: () => NodeJS.CpuUsage;
  private readonly cpuCores: number;

  private currentLimit: number;
  private inFlightCount = 0;
  private readonly window: Completion[] = [];
  private rttLongMs?: number;
  private cpuPct?: number;
  private lastAdjust?: WorkerAdjust;

  private completionsThisTick = 0;
  private stallTicks = 0;
  private lastCpuUsage?: NodeJS.CpuUsage;
  private lastCpuSampleAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AdaptiveControllerOptions = {}) {
    this.resolved = resolveConcurrency(options.concurrency);
    this.apply = options.apply ?? (() => {});
    this.now = options.now ?? Date.now;
    this.readRss = options.readRss ?? (() => process.memoryUsage().rss);
    this.memoryLimitBytes = (options.readMemoryLimit ?? readMemoryLimitBytes)();
    this.tickMs = this.resolved.adaptive?.tickMs ?? DEFAULT_TICK_MS;
    this.readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
    this.cpuCores = wholeAtLeastOne((options.readCpuCount ?? (() => cpus().length))(), 1);
    this.currentLimit =
      this.resolved.mode === 'adaptive'
        ? (this.resolved.adaptive?.start ?? DEFAULT_MIN)
        : (this.resolved.fixed ?? 1);
  }

  /** The concurrency to hand the BullMQ Worker on construction (fixed N, or the adaptive `start`). */
  get initialLimit(): number {
    return this.currentLimit;
  }

  /** The live limit in effect right now. */
  get limit(): number {
    return this.currentLimit;
  }

  /** `true` when the controller will move the limit on its own (adaptive mode). */
  get isAdaptive(): boolean {
    return this.resolved.mode === 'adaptive';
  }

  /**
   * Start the control loop (adaptive mode only; fixed mode just takes a CPU baseline). The timer is
   * `unref`'d so it never keeps the process alive; idempotent.
   */
  start(): void {
    if (this.timer) return;
    if (!this.lastCpuUsage) this.resetCpuBaseline();
    if (!this.isAdaptive) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  /** Stop the control loop (call on worker close). Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** A task started — bump in-flight. Call from the job processor before awaiting the body. */
  onStart(): void {
    this.inFlightCount += 1;
  }

  /**
   * A task settled. ALWAYS drops in-flight and counts toward stall liveness (`completionsThisTick`),
   * so the saturation gate, the heartbeat `inFlight`, and the "alive-but-busy" signal see every task.
   *
   * `kind` gates the MEASUREMENT window: only `'step'` completions push a duration into the rolling
   * window that feeds the latency gradient / throughput / p95 / error rate. A workflow TURN
   * (`kind: 'workflow'`) is NOT measured — a 5ms suspend sitting next to a 2s step would corrupt the
   * gradient — but it still counts as in-flight + forward progress. This is the single concurrency
   * pool measuring steps only; the transport tags the kind when it routes a job by shape.
   */
  onSettle(durationMs: number, ok: boolean, kind: 'workflow' | 'step'): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    // Forward progress for stall detection counts BOTH kinds — a worker churning workflow turns is
    // not stalled even when no step settles this tick.
    this.completionsThisTick += 1;
    if (kind !== 'step') return;
    this.window.push({ durationMs, ok, at: this.now() });
    if (this.window.length > WINDOW_SIZE) this.window.shift();
  }

  /**
   * One control-loop iteration: sample CPU, refresh the latency baseline, then decide the next limit
   * and apply it. A no-op in fixed mode. Exposed (not private) so a test can drive ticks
   * deterministically.
   */
  tick(): void {
    if (this.resolved.mode !== 'adaptive' || !this.resolved.adaptive) return;
    this.sampleCpu(this.tickMs);
    this.refreshRttLong();

    // Stall = in-flight work but no completion this tick, sustained over STALL_TICKS.
    if (this.inFlightCount > 0 && this.completionsThisTick === 0) this.stallTicks += 1;
    else this.stallTicks = 0;
    const stalled = this.stallTicks >= STALL_TICKS;
    this.completionsThisTick = 0;

    this.decide(this.resolved.adaptive, stalled);
  }

  private resetCpuBaseline(): void {
    this.lastCpuUsage = this.readCpuUsage();
    this.lastCpuSampleAt = this.now();
  }

  /** Set `cpuPct` from the CPU time spent since the previous sample, over `elapsedMs` of wall time. */
  private sampleCpu(elapsedMs: number): void {
    const previous = this.lastCpuUsage;
    this.resetCpuBaseline();
    if (!previous || !this.lastCpuUsage || elapsedMs <= 0) return;
    // CpuUsage is microseconds of CPU; elapsedMs of wall time is elapsedMs*1000 micros per core.
    const micros =
      this.lastCpuUsage.user - previous.user + (this.lastCpuUsage.system - previous.system);
    const pct = (micros / (elapsedMs * 1000 * this.cpuCores)) * 100;
    if (Number.isFinite(pct)) this.cpuPct = Math.max(0, pct);
  }

  /** Fixed mode has no control loop, so a snapshot samples CPU itself, at most once per tick period
   *  (several heartbeat keys snapshot back to back, and a near-zero span gives a meaningless rate). */
  private sampleCpuForSnapshot(): void {
    if (this.isAdaptive) return;
    if (!this.lastCpuUsage) {
      this.resetCpuBaseline();
      return;
    }
    const elapsedMs = this.now() - this.lastCpuSampleAt;
    if (elapsedMs >= this.tickMs) this.sampleCpu(elapsedMs);
  }

  private refreshRttLong(): void {
    if (this.window.length === 0) return;
    let minDuration = this.window[0]?.durationMs ?? 0;
    for (const c of this.window) if (c.durationMs < minDuration) minDuration = c.durationMs;
    this.rttLongMs =
      this.rttLongMs === undefined
        ? minDuration
        : RTT_LONG_EWMA_ALPHA * minDuration + (1 - RTT_LONG_EWMA_ALPHA) * this.rttLongMs;
  }

  private rssPct(): number {
    if (this.memoryLimitBytes <= 0) return 0;
    return (100 * this.readRss()) / this.memoryLimitBytes;
  }

  private decide(cfg: AdaptiveConfig, stalled: boolean): void {
    const current = this.currentLimit;
    const durations = this.window.map((c) => c.durationMs).sort((a, b) => a - b);
    const p50 = percentile(durations, 50);
    const errors = this.window.reduce((n, c) => n + (c.ok ? 0 : 1), 0);
    const errorRate = this.window.length === 0 ? 0 : errors / this.window.length;
    const gradient =
      this.rttLongMs !== undefined && p50 > 0 ? Math.min(1, this.rttLongMs / p50) : 1;
    const rssPct = this.rssPct();
    const saturated = this.inFlightCount >= current * 0.8;

    let next = current;
    let reason: WorkerAdjust['reason'] | undefined;

    if (rssPct >= cfg.ramCeilingPct) {
      next = Math.max(cfg.min, Math.floor(current * 0.8));
      reason = 'ram_ceiling';
    } else if (cfg.cpuCeilingPct !== undefined && (this.cpuPct ?? 0) >= cfg.cpuCeilingPct) {
      // CPU at/over the ceiling: never grow; shed one to relieve it.
      next = Math.max(cfg.min, current - 1);
      reason = 'cpu_ceiling';
    } else if (errorRate > 0.2 || stalled) {
      next = Math.max(cfg.min, current - 1);
      reason = 'backpressure';
    } else if (gradient < 0.7) {
      next = Math.max(cfg.min, Math.floor(current * gradient));
      reason = 'shrink';
    } else if (gradient >= 0.9 && saturated) {
      next = Math.min(cfg.max, current + 1);
      reason = 'grow';
    }

    next = clamp(next, cfg.min, cfg.max);
    if (next === current || reason === undefined) return;

    this.currentLimit = next;
    this.lastAdjust = { at: this.now(), from: current, to: next, reason };
    this.apply(next);
  }

  /** The shared {@link WorkerStatus} the heartbeat writer stamps. Best-effort fields are omitted when
   *  unmeasured (no completions yet → no p95/throughput; no CPU sample yet → no `cpuPct`). */
  snapshot(): WorkerStatus {
    this.sampleCpuForSnapshot();
    const durations = this.window.map((c) => c.durationMs).sort((a, b) => a - b);
    const rssBytes = this.readRss();
    const rssLimitBytes = this.memoryLimitBytes;
    const status: WorkerStatus = {
      runtime: 'node',
      concurrency: {
        mode: this.resolved.mode,
        limit: this.currentLimit,
        ...(this.resolved.mode === 'adaptive' && this.resolved.adaptive
          ? { min: this.resolved.adaptive.min, max: this.resolved.adaptive.max }
          : {}),
      },
      inFlight: this.inFlightCount,
      rssBytes,
      rssLimitBytes,
      rssPct: rssLimitBytes > 0 ? (100 * rssBytes) / rssLimitBytes : 0,
    };
    if (this.cpuPct !== undefined) status.cpuPct = this.cpuPct;
    if (this.window.length > 0) {
      status.throughputPerMin = this.throughputPerMin();
      status.p95Ms = percentile(durations, 95);
    }
    if (this.lastAdjust) status.lastAdjust = this.lastAdjust;
    return status;
  }

  /**
   * Completions per minute over the trailing minute: the window's completions from the last minute,
   * over the span from the oldest of them (or a full minute, when the window reaches further back) to
   * now, floored at a second. The rate decays while the worker is idle and reads 0 once a minute passes with no completion.
   */
  private throughputPerMin(): number {
    const first = this.window[0];
    if (!first) return 0;
    const now = this.now();
    const recent = this.window.filter((c) => now - c.at <= THROUGHPUT_WINDOW_MS).length;
    if (recent === 0) return 0;
    const spanMs = clamp(now - first.at, THROUGHPUT_MIN_SPAN_MS, THROUGHPUT_WINDOW_MS);
    return (recent / spanMs) * 60_000;
  }
}

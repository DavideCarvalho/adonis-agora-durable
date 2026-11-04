import type { WorkflowEngine } from '../index.js';
import { isRemoteEvent } from '../remote-event.js';

export interface DurationStats {
  count: number;
  /** Median, 95th percentile, and max — in milliseconds. */
  p50: number;
  p95: number;
  max: number;
}

export interface DurableMetricsSnapshot {
  runs: {
    started: number;
    completed: number;
    failed: number;
    suspended: number;
    /** Failures handed to an onError handler instead of failing the run. */
    routed: number;
    /** Failures that had onError routes the engine could not apply (workers disagree). */
    unrouted: number;
    /** Subscriber runs started by a settled run's lifecycle event. */
    triggered: number;
    /** Subscribers a settled run's lifecycle event could not start (`where` threw, start failed). */
    triggerFailed: number;
  };
  /** Routed failures by error code (`*` for a failure without one). */
  routedByCode: Record<string, number>;
  /**
   * The `durable.runs.triggered` counter by its attributes: `workflow` (the settled run's) and
   * `subscriber` (the workflow its lifecycle event started), keyed by workflow, then subscriber.
   */
  triggeredBySubscriber: Record<string, Record<string, number>>;
  steps: { completed: number; failed: number };
  /** Per-step wall-clock (from the `durationMs` on step events). */
  stepDurationMs: DurationStats;
  /** Per-run wall-clock, measured `run.started` → terminal. */
  runDurationMs: DurationStats;
}

export interface DurableMetrics {
  /** A point-in-time copy of the counters and duration percentiles. */
  snapshot(): DurableMetricsSnapshot;
  /** Zero everything (e.g. between scrape windows). */
  reset(): void;
  /** Stop collecting. */
  unsubscribe(): void;
}

/**
 * Most `run.started` entries kept waiting for their terminal event. A run that starts here but never
 * ends here (suspended and resumed on another pod, cancelled, reclaimed elsewhere) would otherwise
 * stay in the map forever. Past the cap the OLDEST start is dropped — only a run still in flight
 * after this many newer starts loses its (single) duration sample.
 */
export const MAX_TRACKED_RUN_STARTS = 10_000;

/**
 * Exact duration samples as a value → occurrences histogram. Durations are whole milliseconds, so
 * memory grows with the number of DISTINCT values (bounded by the duration range) instead of with
 * the number of samples, and percentiles stay identical to sorting every sample.
 */
class DurationSamples {
  private readonly counts = new Map<number, number>();
  private total = 0;

  add(value: number): void {
    this.counts.set(value, (this.counts.get(value) ?? 0) + 1);
    this.total += 1;
  }

  stats(): DurationStats {
    if (this.total === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
    const values = [...this.counts.keys()].sort((a, b) => a - b);
    const n = this.total;
    // The value at sorted-sample index `i`, walking cumulative counts.
    const atIndex = (i: number): number => {
      let seen = 0;
      for (const v of values) {
        seen += this.counts.get(v) ?? 0;
        if (i < seen) return v;
      }
      return values[values.length - 1] ?? 0;
    };
    const at = (p: number) => atIndex(Math.min(n - 1, Math.floor((p / 100) * n)));
    return { count: n, p50: at(50), p95: at(95), max: values[values.length - 1] ?? 0 };
  }
}

/**
 * Collect lightweight, dependency-free metrics from engine lifecycle events: run/step counts by
 * outcome and run/step duration percentiles. Pull `snapshot()` from a `/metrics` route, a Telescope
 * pulse, or a scheduled exporter. Returns a handle with `snapshot()`, `reset()` and `unsubscribe()`.
 *
 * Has no OpenTelemetry dependency — it lives alongside the OTel bridge for convenience, but works on
 * its own.
 */
export function attachDurableMetrics(engine: WorkflowEngine): DurableMetrics {
  const zeroRuns = () => ({
    started: 0,
    completed: 0,
    failed: 0,
    suspended: 0,
    routed: 0,
    unrouted: 0,
    triggered: 0,
    triggerFailed: 0,
  });
  let runs = zeroRuns();
  let routedByCode: Record<string, number> = {};
  let triggeredBy: Record<string, Record<string, number>> = {};
  let steps = { completed: 0, failed: 0 };
  let stepDur = new DurationSamples();
  let runDur = new DurationSamples();
  const runStart = new Map<string, number>();

  const finishRun = (runId: string, at: Date): void => {
    const t0 = runStart.get(runId);
    if (t0 != null) {
      runDur.add(at.getTime() - t0);
      runStart.delete(runId);
    }
  };

  const unsubscribe = engine.subscribe((e) => {
    // Only events this instance produced: another instance's arrive over the control plane and are
    // counted there, so counting them here too would multiply every number by the fleet size.
    if (isRemoteEvent(e)) return;
    switch (e.type) {
      case 'run.started':
        runs.started += 1;
        // Re-insert so the map's insertion order stays oldest-start-first for eviction.
        runStart.delete(e.runId);
        runStart.set(e.runId, e.at.getTime());
        if (runStart.size > MAX_TRACKED_RUN_STARTS) {
          const oldest = runStart.keys().next().value;
          if (oldest !== undefined) runStart.delete(oldest);
        }
        break;
      case 'run.completed':
        runs.completed += 1;
        finishRun(e.runId, e.at);
        break;
      case 'run.failed':
        runs.failed += 1;
        finishRun(e.runId, e.at);
        break;
      case 'run.suspended':
        runs.suspended += 1;
        break;
      case 'run.routed': {
        runs.routed += 1;
        const code = e.error?.code ?? '*';
        routedByCode[code] = (routedByCode[code] ?? 0) + 1;
        break;
      }
      case 'run.unrouted':
        runs.unrouted += 1;
        break;
      case 'run.triggered': {
        runs.triggered += 1;
        const workflow = e.workflow ?? 'unknown';
        const subscriber = e.name ?? 'unknown';
        const bySubscriber = triggeredBy[workflow] ?? {};
        bySubscriber[subscriber] = (bySubscriber[subscriber] ?? 0) + 1;
        triggeredBy[workflow] = bySubscriber;
        break;
      }
      case 'run.trigger_failed':
        runs.triggerFailed += 1;
        break;
      case 'step.completed':
        steps.completed += 1;
        if (e.durationMs != null) stepDur.add(e.durationMs);
        break;
      case 'step.failed':
        steps.failed += 1;
        if (e.durationMs != null) stepDur.add(e.durationMs);
        break;
    }
  });

  return {
    snapshot: () => ({
      runs: { ...runs },
      routedByCode: { ...routedByCode },
      triggeredBySubscriber: structuredClone(triggeredBy),
      steps: { ...steps },
      stepDurationMs: stepDur.stats(),
      runDurationMs: runDur.stats(),
    }),
    reset: () => {
      runs = zeroRuns();
      routedByCode = {};
      triggeredBy = {};
      steps = { completed: 0, failed: 0 };
      stepDur = new DurationSamples();
      runDur = new DurationSamples();
      runStart.clear();
    },
    unsubscribe,
  };
}

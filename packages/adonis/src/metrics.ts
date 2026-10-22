import type { EngineEvent } from './interfaces.js';

export interface MetricsSnapshot {
  /** `routed`: failures handed to an onError handler; `unrouted`: routes the engine could not apply. */
  runs: {
    started: number;
    completed: number;
    failed: number;
    suspended: number;
    routed: number;
    unrouted: number;
  };
  /** Routed failures by error code (`*` for a failure without one). */
  routedByCode: Record<string, number>;
  steps: { started: number; completed: number; failed: number };
  /** Per-workflow run counters, keyed by workflow name. */
  byWorkflow: Record<string, { started: number; completed: number; failed: number }>;
  /** Sum + count of recorded step durations (ms), for an average. */
  stepDuration: { sumMs: number; count: number };
}

export interface MetricsCollector {
  snapshot(): MetricsSnapshot;
  /** Prometheus text exposition of the counters — serve this from a `/metrics` endpoint. */
  prometheus(): string;
  /** Unsubscribe from the engine. */
  stop(): void;
}

type Subscribable = { subscribe(listener: (event: EngineEvent) => void): () => void };

/**
 * Subscribe to an engine's lifecycle events and accumulate Prometheus-style counters (runs + steps by
 * outcome, per-workflow run counts, step-duration sum/count). Dependency-free — call `.prometheus()`
 * from your metrics endpoint, or `.snapshot()` for the raw numbers. Counters are per process; scrape
 * each instance.
 */
export function collectMetrics(engine: Subscribable): MetricsCollector {
  const m: MetricsSnapshot = {
    runs: { started: 0, completed: 0, failed: 0, suspended: 0, routed: 0, unrouted: 0 },
    routedByCode: {},
    steps: { started: 0, completed: 0, failed: 0 },
    byWorkflow: {},
    stepDuration: { sumMs: 0, count: 0 },
  };
  const wf = (name?: string) => {
    const k = name ?? 'unknown';
    let entry = m.byWorkflow[k];
    if (!entry) {
      entry = { started: 0, completed: 0, failed: 0 };
      m.byWorkflow[k] = entry;
    }
    return entry;
  };

  const stop = engine.subscribe((e) => {
    switch (e.type) {
      case 'run.started':
        m.runs.started += 1;
        wf(e.workflow).started += 1;
        break;
      case 'run.completed':
        m.runs.completed += 1;
        wf(e.workflow).completed += 1;
        break;
      case 'run.failed':
        m.runs.failed += 1;
        wf(e.workflow).failed += 1;
        break;
      case 'run.suspended':
        m.runs.suspended += 1;
        break;
      case 'run.routed': {
        m.runs.routed += 1;
        const code = e.error?.code ?? '*';
        m.routedByCode[code] = (m.routedByCode[code] ?? 0) + 1;
        break;
      }
      case 'run.unrouted':
        m.runs.unrouted += 1;
        break;
      case 'step.started':
        m.steps.started += 1;
        break;
      case 'step.completed':
        m.steps.completed += 1;
        if (e.durationMs != null) {
          m.stepDuration.sumMs += e.durationMs;
          m.stepDuration.count += 1;
        }
        break;
      case 'step.failed':
        m.steps.failed += 1;
        break;
    }
  });

  return {
    snapshot: () => structuredClone(m),
    stop,
    prometheus: () => {
      const lines: string[] = [];
      lines.push('# TYPE durable_runs_total counter');
      for (const [k, v] of Object.entries(m.runs))
        lines.push(`durable_runs_total{event="${k}"} ${v}`);
      lines.push('# TYPE durable_steps_total counter');
      for (const [k, v] of Object.entries(m.steps))
        lines.push(`durable_steps_total{event="${k}"} ${v}`);
      lines.push('# TYPE durable_runs_by_workflow_total counter');
      for (const [name, v] of Object.entries(m.byWorkflow))
        for (const [event, n] of Object.entries(v))
          lines.push(`durable_runs_by_workflow_total{workflow="${name}",event="${event}"} ${n}`);
      lines.push('# TYPE durable_runs_routed_total counter');
      for (const [code, n] of Object.entries(m.routedByCode))
        lines.push(`durable_runs_routed_total{code="${code}"} ${n}`);
      lines.push('# TYPE durable_step_duration_ms_sum counter');
      lines.push(`durable_step_duration_ms_sum ${m.stepDuration.sumMs}`);
      lines.push('# TYPE durable_step_duration_count counter');
      lines.push(`durable_step_duration_count ${m.stepDuration.count}`);
      return `${lines.join('\n')}\n`;
    },
  };
}

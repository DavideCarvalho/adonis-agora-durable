import type { GroupHealth, WorkerStatus } from '../../client/durable-client';

/** Compact "Nm ago" relative stamp for an epoch-ms instant. */
export function relAgoMs(atMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * One worker's live snapshot: concurrency mode + live limit, in-flight saturation, RAM/CPU%,
 * throughput, p95, and the adaptive controller's last move. A worker from an older SDK with no
 * `status` renders "no status" (a mixed fleet stays visible). Shared by the per-group `WorkerRows`
 * and the by-pod worker view.
 */
export function WorkerStatusCells({ status }: { status: WorkerStatus | undefined }) {
  const c = status?.concurrency;
  if (!status || !c) {
    return <span className="mono text-[9px] text-faint">no status</span>;
  }
  const saturated = c.limit > 0 && status.inFlight >= c.limit * 0.8;
  return (
    <div className="flex flex-col gap-1">
      <div className="mono flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-dim">
        <span
          className={`shrink-0 rounded border px-1 text-[9px] uppercase tracking-wider ${
            c.mode === 'adaptive'
              ? 'border-info/40 bg-info/10 text-info'
              : 'border-line-strong/50 bg-hover/60 text-fg-2'
          }`}
        >
          {c.mode === 'adaptive' ? `adaptive ${c.min ?? 1}–${c.max ?? 32}` : 'fixed'}
        </span>
        <span className={saturated ? 'text-warn' : 'text-fg-2'}>
          in-flight{' '}
          <span className="tnum">
            {status.inFlight}/{c.limit}
          </span>
        </span>
        {typeof status.rssPct === 'number' && (
          <span className={status.rssPct >= 85 ? 'text-bad' : ''}>
            ram <span className="tnum">{Math.round(status.rssPct)}%</span>
          </span>
        )}
        {typeof status.cpuPct === 'number' && (
          <span>
            cpu <span className="tnum">{Math.round(status.cpuPct)}%</span>
          </span>
        )}
        {typeof status.throughputPerMin === 'number' && (
          <span>
            <span className="tnum">{Math.round(status.throughputPerMin)}</span>/min
          </span>
        )}
        {typeof status.p95Ms === 'number' && (
          <span>
            p95 <span className="tnum">{Math.round(status.p95Ms)}ms</span>
          </span>
        )}
      </div>
      {status.lastAdjust && (
        <div className="mono text-[10px] text-dim">
          {status.lastAdjust.reason}{' '}
          <span className="tnum text-fg-2">
            {status.lastAdjust.from}→{status.lastAdjust.to}
          </span>{' '}
          {relAgoMs(status.lastAdjust.at)}
        </div>
      )}
    </div>
  );
}

/** Per-worker rows for an expanded group: each live worker's id + its {@link WorkerStatusCells}. */
export function WorkerRows({ workers }: { workers: GroupHealth['liveWorkers'] }) {
  return (
    <div className="flex flex-col divide-y divide-line-soft">
      {workers.map((w) => (
        <div key={w.instanceId} className="flex flex-col gap-1 px-2.5 py-2">
          <span className="mono truncate text-[10px] text-fg-2">{w.instanceId}</span>
          <WorkerStatusCells status={w.status} />
        </div>
      ))}
    </div>
  );
}

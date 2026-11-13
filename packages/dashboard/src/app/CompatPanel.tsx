import { DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { CheckIcon } from '../agora-kit/icons';
import { cn } from '../agora-kit/lib/utils';
import { Badge } from '../agora-kit/ui/badge';
import type {
  CompatBlockedRun,
  CompatOutcome,
  CompatPod,
  CompatReport,
} from '../client/durable-client';

/**
 * Fleet health / protocol compatibility (`GET /compat`, design §7.6, §10), as two presentational
 * blocks for the Workers page:
 *
 * - {@link CompatFleetTable}: every live worker descriptor negotiated against the control plane —
 *   routing token, pod, protocol band, outcome, and the exact red-flag reason plus capability delta
 *   when incompatible.
 * - {@link BlockedRunsList}: runs parked because no compatible worker can take them, each with its
 *   human reason; clicking one opens its detail (the reason is per run, so the fix starts there).
 *
 * "no descriptors" is said out loud when nothing has advertised yet (a legacy fleet, or a transport
 * without enumeration) — absence of data must not read as "all compatible".
 */

/** Render a protocol band `[min, max]` compactly: `v1` for a single major, `v1–2` for a range.
 *  Mirrors the server's `compat-view.ts` helper byte-for-byte so the two surfaces can't drift. */
export function formatProtocolRange(range: [number, number]): string {
  return range[0] === range[1] ? `v${range[0]}` : `v${range[0]}–${range[1]}`;
}

/** The fleet's overall tone: the WORST outcome across every pod wins. */
export function fleetOutcome(report: Pick<CompatReport, 'groups'>): CompatOutcome {
  if (report.groups.some((g) => g.incompatible)) return 'incompatible';
  if (report.groups.some((g) => g.degraded)) return 'degraded';
  return 'compatible';
}

/** Status-dot class for a negotiation outcome (reuses the run-status hues: good/warn/bad). */
export function outcomeDot(outcome: CompatOutcome): string {
  if (outcome === 'incompatible') return 's-failed';
  if (outcome === 'degraded') return 's-suspended';
  return 's-completed';
}

interface PodRow {
  token: string;
  pod: CompatPod;
}

export function CompatFleetTable({ compat }: { compat: CompatReport }) {
  if (compat.groups.length === 0) {
    return (
      <EmptyState
        icon={<CheckIcon />}
        title="no descriptors"
        description="No worker has advertised a handshake descriptor yet — legacy workers are assumed compatible."
      />
    );
  }
  const rows: PodRow[] = compat.groups.flatMap((group) =>
    group.pods.map((pod) => ({ token: group.token, pod })),
  );
  return (
    <DataTable
      label="Fleet compatibility"
      rows={rows}
      rowKey={(r) => `${r.token}/${r.pod.instanceId}`}
      columns={[
        {
          id: 'pod',
          header: 'Pod',
          cell: (r) => (
            <div className="flex min-w-0 flex-col">
              <span className="mono flex items-center gap-1.5 text-[12px] text-fg">
                <span className={`dot ${outcomeDot(r.pod.outcome)}`} aria-hidden />
                <span className="truncate">{r.pod.instanceId}</span>
              </span>
              <span className="mono truncate text-[10px] text-dim">{r.token}</span>
            </div>
          ),
        },
        {
          id: 'protocol',
          header: 'Protocol',
          cell: (r) => (
            <span className="mono tnum text-[12px] text-fg-2">
              {formatProtocolRange(r.pod.protocolRange)}
            </span>
          ),
        },
        {
          id: 'outcome',
          header: 'Outcome',
          cell: (r) => (
            <Badge
              variant={
                r.pod.outcome === 'incompatible'
                  ? 'destructive'
                  : r.pod.outcome === 'degraded'
                    ? 'warn'
                    : 'good'
              }
              className="mono text-[10px] uppercase tracking-wider"
            >
              {r.pod.outcome}
            </Badge>
          ),
        },
        {
          id: 'detail',
          header: 'Detail',
          hideBelow: 'md',
          className: 'whitespace-normal',
          cell: (r) => (
            <div className="mono flex flex-col gap-0.5 text-[11px]">
              {r.pod.reason && <span className="text-bad">{r.pod.reason}</span>}
              {r.pod.missingOnRemote.length > 0 && (
                <span className="text-dim">
                  missing on worker: {r.pod.missingOnRemote.join(', ')}
                </span>
              )}
              {r.pod.missingOnLocal.length > 0 && (
                <span className="text-dim">
                  missing on control plane: {r.pod.missingOnLocal.join(', ')}
                </span>
              )}
              {!r.pod.reason &&
                r.pod.missingOnRemote.length === 0 &&
                r.pod.missingOnLocal.length === 0 && <span className="text-faint">—</span>}
            </div>
          ),
        },
      ]}
    />
  );
}

export function BlockedRunsList({
  blocked,
  onOpenRun,
}: {
  blocked: CompatBlockedRun[];
  onOpenRun: (id: string) => void;
}) {
  if (blocked.length === 0) {
    return (
      <EmptyState
        icon={<CheckIcon />}
        title="No blocked runs"
        description="Every parked run has a compatible worker to resume it."
      />
    );
  }
  return (
    <ul className="divide-y divide-line-soft">
      {blocked.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            onClick={() => onOpenRun(run.id)}
            className={cn(
              'mono flex w-full flex-col gap-0.5 px-4 py-3 text-left text-[11px] transition-colors hover:bg-hover',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="dot s-blocked" aria-hidden />
              <span className="truncate text-[12.5px] text-fg">{run.workflow}</span>
              <span className="truncate text-faint">{run.id}</span>
            </span>
            <span className="text-bad">{run.reason}</span>
            {run.missingCapabilities && run.missingCapabilities.length > 0 && (
              <span className="text-dim">missing: {run.missingCapabilities.join(', ')}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

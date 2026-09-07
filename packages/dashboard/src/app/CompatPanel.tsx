import { useState } from 'react';
import type { CompatOutcome, CompatPod, CompatReport } from '../client/durable-client';
import { Button } from './ui/button';
import { cn } from './ui/cn';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip } from './ui/tooltip';

/**
 * The fleet-health / protocol-compatibility view of the header's workers panel (`GET /compat` —
 * design §7.6, §10). Two chips, matching the sibling views' chip-with-popover idiom:
 *
 * - **fleet** — every live worker descriptor negotiated against the control plane, rolled up to one
 *   chip (green all-compatible / amber degraded / red incompatible) whose popover lists each routing
 *   token's pods with their protocol band, negotiation outcome, and — when incompatible — the exact
 *   red-flag reason plus the capability delta.
 * - **blocked** — runs parked because no compatible worker can take them, each with its human
 *   reason; clicking a run opens its detail (the reason is per-run, so the fix starts there).
 *
 * Renders a quiet "no descriptors" note when nothing has advertised yet (a legacy fleet, or a
 * transport without the enumeration capability) — absence of data must not read as "all compatible".
 */

/** Render a protocol band `[min, max]` compactly: `v1` for a single major, `v1–2` for a range.
 *  Mirrors the server's `compat-view.ts` helper byte-for-byte so the two surfaces can't drift. */
export function formatProtocolRange(range: [number, number]): string {
  return range[0] === range[1] ? `v${range[0]}` : `v${range[0]}–${range[1]}`;
}

/** The fleet chip's overall tone: the WORST outcome across every pod wins the colour. */
export function fleetOutcome(report: Pick<CompatReport, 'groups'>): CompatOutcome {
  if (report.groups.some((g) => g.incompatible)) return 'incompatible';
  if (report.groups.some((g) => g.degraded)) return 'degraded';
  return 'compatible';
}

/** Status-dot class for a negotiation outcome (reuses the run-status hues: good/warn/bad). */
function outcomeDot(outcome: CompatOutcome): string {
  if (outcome === 'incompatible') return 's-failed';
  if (outcome === 'degraded') return 's-suspended';
  return 's-completed';
}

/** One pod's negotiation row inside the fleet popover. */
function PodCompatRow({ pod }: { pod: CompatPod }) {
  return (
    <div className="flex flex-col gap-0.5 px-2.5 py-1.5">
      <div className="mono flex items-center gap-1.5 text-[10px]">
        <span className={`dot ${outcomeDot(pod.outcome)}`} aria-hidden />
        <span className="truncate text-zinc-300">{pod.instanceId}</span>
        <span className="tnum shrink-0 text-zinc-500">
          {formatProtocolRange(pod.protocolRange)}
        </span>
        <span
          className={cn(
            'shrink-0 uppercase tracking-wider',
            pod.outcome === 'incompatible' && 'text-rose-300',
            pod.outcome === 'degraded' && 'text-amber-300',
            pod.outcome === 'compatible' && 'text-zinc-500',
          )}
        >
          {pod.outcome}
        </span>
      </div>
      {pod.reason && <div className="mono text-[10px] text-rose-300/80">{pod.reason}</div>}
      {pod.missingOnRemote.length > 0 && (
        <div className="mono text-[10px] text-zinc-500">
          missing on worker: {pod.missingOnRemote.join(', ')}
        </div>
      )}
      {pod.missingOnLocal.length > 0 && (
        <div className="mono text-[10px] text-zinc-500">
          missing on control plane: {pod.missingOnLocal.join(', ')}
        </div>
      )}
    </div>
  );
}

export function CompatHealth({
  compat,
  onOpenRun,
}: {
  compat: CompatReport | undefined;
  onOpenRun: (id: string) => void;
}) {
  const [open, setOpen] = useState<'fleet' | 'blocked' | undefined>(undefined);
  if (!compat) return null;
  const outcome = fleetOutcome(compat);
  const podCount = compat.groups.reduce((n, g) => n + g.pods.length, 0);
  const fleetOpen = open === 'fleet';
  const blockedOpen = open === 'blocked';
  return (
    <>
      {compat.groups.length === 0 ? (
        // A legacy fleet (no descriptors advertised) is assume-compatible, but say so instead of
        // showing an empty green chip that claims everything negotiated fine.
        <Tooltip label="No worker has advertised a handshake descriptor yet — legacy workers are assumed compatible.">
          <span className="mono text-[10px] text-zinc-600">no descriptors</span>
        </Tooltip>
      ) : (
        <Popover open={fleetOpen} onOpenChange={(next) => setOpen(next ? 'fleet' : undefined)}>
          <Tooltip
            suppressed={fleetOpen}
            label={`control plane ${formatProtocolRange(compat.controlPlane.protocolRange)}\n${podCount} pods across ${compat.groups.length} groups${compat.incompatibleCount > 0 ? ` · ${compat.incompatibleCount} incompatible` : ''}`}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="chip"
                  size="xs"
                  className={cn(
                    'mono gap-1',
                    outcome === 'incompatible' && 'border-rose-500/50 bg-rose-500/15 text-rose-300',
                    outcome === 'degraded' && 'border-warn/40 bg-warn/10 text-warn',
                    outcome === 'compatible' &&
                      fleetOpen &&
                      'border-zinc-500 bg-zinc-800 text-zinc-200',
                  )}
                >
                  <span className={`dot ${outcomeDot(outcome)}`} aria-hidden />
                  fleet
                  <span className="tnum text-zinc-500">
                    {podCount}p{compat.incompatibleCount > 0 ? ` ${compat.incompatibleCount}!` : ''}
                  </span>
                </Button>
              }
            />
          </Tooltip>
          <PopoverContent>
            <div className="mono flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5 text-[10px] text-zinc-500">
              <span className="truncate text-zinc-300">{compat.controlPlane.instanceId}</span>
              <span className="tnum shrink-0">
                control plane {formatProtocolRange(compat.controlPlane.protocolRange)}
              </span>
            </div>
            <div className="max-h-80 divide-y divide-line-soft overflow-auto">
              {compat.groups.map((group) => (
                <div key={group.token}>
                  <div className="mono flex items-center gap-1.5 bg-zinc-900/40 px-2.5 py-1 text-[9px] uppercase tracking-wider text-zinc-600">
                    <span className="truncate">{group.token}</span>
                    {group.incompatible && <span className="text-rose-300">incompatible</span>}
                    {!group.incompatible && group.degraded && (
                      <span className="text-amber-300">degraded</span>
                    )}
                  </div>
                  {group.pods.map((pod) => (
                    <PodCompatRow key={pod.instanceId} pod={pod} />
                  ))}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
      {compat.blockedCount > 0 && (
        <Popover open={blockedOpen} onOpenChange={(next) => setOpen(next ? 'blocked' : undefined)}>
          <Tooltip
            suppressed={blockedOpen}
            label={`${compat.blockedCount} run${compat.blockedCount === 1 ? '' : 's'} parked: no compatible worker can take ${compat.blockedCount === 1 ? 'it' : 'them'}`}
          >
            <PopoverTrigger
              render={
                <Button
                  variant="chip"
                  size="xs"
                  className="mono gap-1 border-rose-500/50 bg-rose-500/15 text-rose-300"
                >
                  <span className="dot s-blocked" aria-hidden />
                  <span className="tnum">{compat.blockedCount}</span> blocked
                </Button>
              }
            />
          </Tooltip>
          <PopoverContent>
            <div className="mono border-b border-line px-2.5 py-1.5 text-[9px] uppercase tracking-wider text-zinc-600">
              blocked runs
            </div>
            <div className="max-h-80 divide-y divide-line-soft overflow-auto">
              {compat.blocked.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  onClick={() => {
                    setOpen(undefined);
                    onOpenRun(run.id);
                  }}
                  className="mono flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left text-[10px] hover:bg-zinc-800/50"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-zinc-300">{run.workflow}</span>
                    <span className="truncate text-zinc-600">{run.id}</span>
                  </span>
                  <span className="text-rose-300/80">{run.reason}</span>
                  {run.missingCapabilities && run.missingCapabilities.length > 0 && (
                    <span className="text-zinc-500">
                      missing: {run.missingCapabilities.join(', ')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { durableClient, type ScheduleInfo } from '../client/durable-client';
import { PlayIcon } from './icons';
import { Badge as Chip } from './ui/badge';
import { Button } from './ui/button';
import { cn } from './ui/cn';
import { Tooltip } from './ui/tooltip';

/**
 * The Schedules view: every ticked schedule (`GET /schedules`) with its cadence, fire windows and
 * live control state, plus the runtime verbs — Pause/Resume fleet-wide and "Run now"
 * (`POST /schedules/:key/pause|resume|trigger`). "Run now" navigates straight to the run the
 * trigger started (the current window's deterministic run), the same way fix-and-replay opens its
 * fresh run.
 *
 * On a topology without runtime schedule control (a store-less `tenant` pod, or a server older than
 * the endpoint) `GET /schedules` answers 404 — the header hides the tab on a tenant role already
 * (same gating as fix-and-replay), and this panel degrades to an "unavailable" note rather than an
 * empty table for the older-server case the role can't predict.
 */

/** Humanize an `everyMs` cadence: `30s`, `5m`, `1.5h`, `2d` — one unit, one decimal at most. */
export function humanizeEveryMs(ms: number): string {
  const unit = (n: number, u: string) => `${Number.isInteger(n) ? n : n.toFixed(1)}${u}`;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return unit(s, 's');
  const m = s / 60;
  if (m < 60) return unit(m, 'm');
  const h = m / 60;
  if (h < 24) return unit(h, 'h');
  return unit(h / 24, 'd');
}

/** A schedule's cadence, as the operator declared it: the cron expression verbatim (an operator who
 *  wrote `0 3 * * *` recognises it faster than any prose), or the humanized `everyMs` interval. */
export function cadenceOf(s: Pick<ScheduleInfo, 'cron' | 'everyMs'>): string {
  if (s.cron) return s.cron;
  if (s.everyMs != null) return `every ${humanizeEveryMs(s.everyMs)}`;
  return '—';
}

/** Compact relative stamp for a FUTURE epoch-ms instant (`in 4m`); a past one reads `due now` —
 *  the ticker simply hasn't reached it yet, which is not the same claim as a missed fire. */
export function relUntilMs(atMs: number, nowMs = Date.now()): string {
  const diff = atMs - nowMs;
  if (diff <= 0) return 'due now';
  const s = Math.round(diff / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

const COLUMNS =
  'grid grid-cols-[minmax(140px,1.2fr)_minmax(120px,1fr)_minmax(110px,0.9fr)_90px_90px_minmax(110px,0.9fr)_auto] items-center gap-3 px-5';

function ScheduleRow({ s, onOpenRun }: { s: ScheduleInfo; onOpenRun: (id: string) => void }) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['schedules'] });
  const setPaused = useMutation({
    mutationFn: (paused: boolean) => durableClient.setSchedulePaused(s.key, paused),
    onSuccess: invalidate,
  });
  // "Run now" answers with the current window's run — open it, exactly like fix-and-replay opens
  // the fresh linked run it started.
  const trigger = useMutation({
    mutationFn: () => durableClient.triggerSchedule(s.key),
    onSuccess: (result) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['runs'] });
      onOpenRun(result.runId);
    },
  });
  const tenant = s.namespace && s.namespace !== 'default' ? s.namespace : undefined;
  return (
    <li className={cn(COLUMNS, 'py-3')}>
      <div className="min-w-0">
        <div className="mono truncate text-[12px] text-zinc-200">{s.key}</div>
        {s.overlap === 'skip' && (
          <div className="mono text-[9px] uppercase tracking-wider text-zinc-600">no overlap</div>
        )}
      </div>
      <div className="mono flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-400">
        <span className="truncate">{s.workflow}</span>
        {tenant && (
          <Chip variant="tenant" className="mono shrink-0 px-1 text-[9px]">
            {tenant}
          </Chip>
        )}
      </div>
      <span className="mono truncate text-[11px] text-zinc-300" title={cadenceOf(s)}>
        {cadenceOf(s)}
      </span>
      <span className="mono truncate text-[10px] text-zinc-500">{s.timezone ?? 'UTC'}</span>
      <span
        className={cn('mono tnum text-[11px]', s.paused ? 'text-zinc-600' : 'text-zinc-400')}
        title={new Date(s.nextFireAt).toISOString()}
      >
        {s.paused ? '—' : relUntilMs(s.nextFireAt)}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {s.lastRunStatus ? (
          // The current window's run exists — its status chip IS the link to it.
          <button
            type="button"
            onClick={() => onOpenRun(s.currentWindowRunId)}
            title={`Open the current window's run (${s.currentWindowRunId})`}
            className="cursor-pointer"
          >
            <Chip variant="status" className={`s-${s.lastRunStatus} text-[11px] hover:underline`}>
              <span className={`dot s-${s.lastRunStatus}`} aria-hidden />
              {s.lastRunStatus}
            </Chip>
          </button>
        ) : (
          <span
            className="mono text-[11px] text-zinc-600"
            title="The current window has no run yet"
          >
            —
          </span>
        )}
        {s.paused && (
          <Tooltip
            label={
              s.pausedAtRuntime
                ? 'Paused by a runtime override (from this console) — it survives until resumed, overriding the config.'
                : 'Paused in the schedule config.'
            }
          >
            <Chip variant="warn" className="mono py-0.5 uppercase tracking-wider">
              paused{s.pausedAtRuntime ? ' · runtime override' : ''}
            </Chip>
          </Tooltip>
        )}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-2">
        <Button
          variant={s.paused ? 'outline' : 'warn'}
          size="xs"
          disabled={setPaused.isPending}
          onClick={() => setPaused.mutate(!s.paused)}
          className="mono uppercase tracking-wider"
          title={
            s.paused
              ? 'Resume this schedule fleet-wide (clears the runtime pause)'
              : 'Pause this schedule fleet-wide, at runtime — the config stays untouched'
          }
        >
          {s.paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="brand"
          size="xs"
          disabled={trigger.isPending}
          onClick={() => trigger.mutate()}
          className="mono uppercase tracking-wider"
          title="Fire the current window now and open its run"
        >
          <PlayIcon width={10} height={10} />
          Run now
        </Button>
      </span>
    </li>
  );
}

export function SchedulesPanel({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const {
    data: schedules,
    error,
    isPending,
  } = useQuery({
    queryKey: ['schedules'],
    queryFn: () => durableClient.schedules(),
    refetchInterval: 5000,
    // A 404 (topology/server without runtime schedule control) must degrade to the note below
    // immediately, not hammer an endpoint that will keep 404ing.
    retry: false,
  });
  if (error) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-md">
          <p className="text-sm text-zinc-400">Schedules are not available here.</p>
          <p className="mono mt-2 text-[11px] text-zinc-600">
            This deployment's server has no runtime schedule control (a tenant topology, or a server
            older than the endpoint) — `GET /schedules` answered: {error.message}
          </p>
        </div>
      </div>
    );
  }
  if (isPending) {
    return <div className="p-8 text-sm text-zinc-600">Loading schedules…</div>;
  }
  if (schedules.length === 0) {
    return (
      <div className="grid h-full place-items-center text-sm text-zinc-600">
        No schedules registered.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-lg font-semibold tracking-tight">Schedules</h2>
        <p className="mono mt-1 text-[11px] text-zinc-600">
          {schedules.length} ticked schedule{schedules.length === 1 ? '' : 's'} · pause/resume is a
          fleet-wide runtime override · "Run now" fires the current window
        </p>
      </div>
      <div
        className={cn(
          COLUMNS,
          'mono border-b border-line py-2 text-[9px] uppercase tracking-[0.18em] text-zinc-600',
        )}
      >
        <span>key</span>
        <span>workflow</span>
        <span>cadence</span>
        <span>timezone</span>
        <span>next fire</span>
        <span>last run</span>
        <span className="text-right">actions</span>
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line-soft overflow-auto">
        {schedules.map((s) => (
          <ScheduleRow key={s.key} s={s} onOpenRun={onOpenRun} />
        ))}
      </ul>
    </div>
  );
}

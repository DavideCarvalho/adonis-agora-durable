import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { Hint as Tooltip } from '../agora-kit/blocks/hint';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { ClockIcon } from '../agora-kit/icons';
import { cn } from '../agora-kit/lib/utils';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Badge as Chip } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Skeleton } from '../agora-kit/ui/skeleton';
import { durableClient, type ScheduleInfo } from '../client/durable-client';
import { PlayIcon } from './icons';

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
  'grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_80px_minmax(0,1.3fr)_176px] items-center gap-3 px-4';

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
        <div className="mono truncate text-[12px] text-fg">{s.key}</div>
        {s.overlap === 'skip' && (
          <div className="mono text-[9px] uppercase tracking-wider text-faint">no overlap</div>
        )}
      </div>
      <div className="mono flex min-w-0 items-center gap-1.5 text-[11px] text-fg-2">
        <span className="truncate">{s.workflow}</span>
        {tenant && (
          <Chip variant="info" className="mono shrink-0 px-1 text-[9px]">
            {tenant}
          </Chip>
        )}
      </div>
      <span className="mono truncate text-[11px] text-fg-2" title={cadenceOf(s)}>
        {cadenceOf(s)}
      </span>
      <span className="mono truncate text-[10px] text-dim">{s.timezone ?? 'UTC'}</span>
      <span
        className={cn('mono tnum text-[11px]', s.paused ? 'text-faint' : 'text-fg-2')}
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
            <Chip variant="bare" className={`s-${s.lastRunStatus} text-[11px] hover:underline`}>
              <span className={`dot s-${s.lastRunStatus}`} aria-hidden />
              {s.lastRunStatus}
            </Chip>
          </button>
        ) : (
          <span className="mono text-[11px] text-faint" title="The current window has no run yet">
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
            <Chip variant="warn" className="mono min-w-0 py-0.5 uppercase tracking-wider">
              paused{s.pausedAtRuntime ? ' · runtime override' : ''}
            </Chip>
          </Tooltip>
        )}
      </span>
      <span className="flex shrink-0 items-center justify-end gap-2">
        <Button
          variant={s.paused ? 'outline' : 'warn'}
          size="micro"
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
          size="micro"
          disabled={trigger.isPending}
          onClick={() => trigger.mutate()}
          className="mono uppercase tracking-wider"
          title="Fire the current window now and open its run"
        >
          <PlayIcon width={10} height={10} />
          Run now
        </Button>
      </span>
      {(setPaused.error || trigger.error) && (
        <div role="alert" className="mono col-span-full text-[11px] text-bad">
          {(() => {
            const failure = setPaused.error ?? trigger.error;
            return `Action failed: ${failure instanceof Error ? failure.message : String(failure)}`;
          })()}
        </div>
      )}
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
  return (
    <PageBody>
      <PageHeader
        title="Schedules"
        description={
          schedules
            ? `${schedules.length} ticked schedule${schedules.length === 1 ? '' : 's'} · pause/resume is a fleet-wide runtime override · "Run now" fires the current window`
            : 'Ticked schedules, their cadence and their current window.'
        }
      />
      <ErrorBoundary label="Schedules">
        <SchedulesView
          schedules={schedules}
          error={error}
          loading={isPending}
          onOpenRun={onOpenRun}
        />
      </ErrorBoundary>
    </PageBody>
  );
}

/** Presentational: the schedules table in its four states (loading, unavailable, empty, rows). */
export function SchedulesView({
  schedules,
  error,
  loading,
  onOpenRun,
}: {
  schedules: ScheduleInfo[] | undefined;
  error: Error | null;
  loading: boolean;
  onOpenRun: (id: string) => void;
}) {
  if (error) {
    return (
      <Panel title="Ticked schedules" flush>
        <EmptyState
          icon={<ClockIcon />}
          title="Schedules are not available here."
          description={
            <span className="mono text-[11px]">
              This deployment's server has no runtime schedule control (a tenant topology, or a
              server older than the endpoint) — `GET /schedules` answered: {error.message}
            </span>
          }
        />
      </Panel>
    );
  }
  return (
    <Panel
      title="Ticked schedules"
      description="key · workflow · cadence · next fire · current window"
      flush
    >
      <div className="overflow-x-auto">
        <div className="min-w-[860px]">
          <div
            className={cn(
              COLUMNS,
              'border-b border-border py-2.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-dim',
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
          {loading || !schedules ? (
            <ul className="divide-y divide-line-soft" aria-hidden>
              {['a', 'b', 'c', 'd'].map((k) => (
                <li key={k} className={cn(COLUMNS, 'py-3.5')}>
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="ml-auto h-6 w-28" />
                </li>
              ))}
            </ul>
          ) : schedules.length === 0 ? (
            <EmptyState
              icon={<ClockIcon />}
              title="No schedules registered."
              description="Declare a schedule on a workflow and it shows up here once the ticker runs."
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {schedules.map((s) => (
                <ScheduleRow key={s.key} s={s} onOpenRun={onOpenRun} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

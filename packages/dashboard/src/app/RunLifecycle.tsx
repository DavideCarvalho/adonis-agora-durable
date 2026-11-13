import { cn } from '../agora-kit/lib/utils';
import { Badge as Chip } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import type {
  LifecycleDelivery,
  RunDetail,
  RunStatus,
  RunWaitLink,
} from '../client/durable-client';
import { CopyButton } from './StepDetailPanel';

/** The tag a settled run carries while its lifecycle event is still owed to some subscriber. */
export const LIFECYCLE_PENDING_TAG = 'durable:lifecycle:pending';

/** A compact span of time: `45s`, `12m`, `3h`, `2d`. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** What a delivery row says about its state, at `now` (epoch ms). */
export function deliveryNote(delivery: LifecycleDelivery, now: number): string {
  switch (delivery.state) {
    case 'started':
      return 'started';
    case 'owed': {
      const since =
        delivery.owedSince !== undefined
          ? `owed for ${formatSpan(now - delivery.owedSince)}`
          : 'owed';
      return delivery.orphanAt !== undefined
        ? `${since} · orphan in ${formatSpan(delivery.orphanAt - now)}`
        : since;
    }
    case 'failed':
      return delivery.error ? `failed: ${delivery.error}` : 'failed';
    case 'coalesced':
      return 'coalesced';
    default:
      return 'not started';
  }
}

/** What `not-started` means, for the row's tooltip. */
const NOT_STARTED_TITLE =
  'No run and nothing owed: its `where` declined the event, or it subscribed after the run settled.';

/** What `failed` means, for the row's tooltip. */
const FAILED_TITLE =
  'Its last delivery failed: `where` threw, the input was rejected, the start failed, or the sweep dropped it as an orphan. The reason is in the run.trigger_failed event. Republish retries it.';

/** What `orphanAt` means, for the row's tooltip. */
const ORPHAN_TITLE =
  'No live instance registers or announces this subscriber; the lifecycle sweep drops it then and reports run.trigger_failed.';

function RunStatusChip({ status }: { status: RunStatus | undefined }) {
  if (!status) return null;
  return (
    <Chip variant="bare" className={`s-${status} text-[10px]`}>
      {status}
    </Chip>
  );
}

function RunChip({ runId, onOpenRun }: { runId: string; onOpenRun: (id: string) => void }) {
  return (
    <Button
      variant="chip"
      size="micro"
      onClick={() => onOpenRun(runId)}
      className="mono max-w-[28rem] truncate px-1.5 py-0"
      title={runId}
    >
      {runId}
    </Button>
  );
}

/**
 * The run that started this one through a lifecycle event: the source run (linked, with its
 * status), how it ended, and the trace id of its span when it recorded one, copyable.
 */
export function LifecycleSourceLine({
  source,
  onOpenRun,
}: {
  source: NonNullable<RunDetail['triggeredBy']>;
  onOpenRun: (id: string) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid="lifecycle-source">
      <span className="text-[10px] text-faint">started by</span>
      <RunChip runId={source.runId} onOpenRun={onOpenRun} />
      <span className="text-[10px] text-faint">on</span>
      <Chip
        variant="neutral"
        className={cn('text-[10px]', source.kind === 'failed' ? 's-failed' : 's-completed')}
      >
        {source.kind}
      </Chip>
      <RunStatusChip status={source.status} />
      {source.traceId && (
        <span className="ml-1 flex items-center gap-1">
          <span className="text-[10px] text-faint">trace</span>
          <span className="mono text-[10px] text-fg-2" title="The source run's trace id">
            {source.traceId}
          </span>
          <CopyButton value={source.traceId} />
        </span>
      )}
    </div>
  );
}

/**
 * The `ctx.waitForRun` waits on either side of a run: "Waiting for run <id>" for each run it waits
 * for, and "Awaited by" for the runs waiting for it, each linked with its status.
 */
export function RunWaits({
  waitsFor = [],
  awaitedBy = [],
  onOpenRun,
}: {
  waitsFor?: readonly RunWaitLink[] | undefined;
  awaitedBy?: readonly RunWaitLink[] | undefined;
  onOpenRun: (id: string) => void;
}) {
  if (waitsFor.length === 0 && awaitedBy.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {waitsFor.map((link) => (
        <div
          key={`${link.runId}#${link.seq}`}
          className="flex flex-wrap items-center gap-1"
          data-testid="waits-for"
        >
          <span className="text-[10px] text-warn/80">Waiting for run</span>
          <RunChip runId={link.runId} onOpenRun={onOpenRun} />
          <RunStatusChip status={link.status} />
        </div>
      ))}
      {awaitedBy.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="awaited-by">
          <span className="text-[10px] text-faint">Awaited by</span>
          {awaitedBy.map((link) => (
            <span key={`${link.runId}#${link.seq}`} className="flex items-center gap-1">
              <RunChip runId={link.runId} onOpenRun={onOpenRun} />
              <RunStatusChip status={link.status} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One row per subscriber of a settled run's lifecycle event: started (its run, linked, with its
 * status), owed (for how long, and when it becomes an orphan if no live instance has it), failed
 * (with the reason when known; the Republish action retries it), coalesced (the accumulator run,
 * when known) or not started.
 */
export function LifecycleDeliveries({
  deliveries,
  errors,
  now = Date.now(),
  onOpenRun,
}: {
  deliveries: readonly LifecycleDelivery[];
  /** The reason of each `failed` subscriber the caller knows (the `run.trigger_failed` events it saw). */
  errors?: ReadonlyMap<string, string> | undefined;
  now?: number;
  onOpenRun: (id: string) => void;
}) {
  if (deliveries.length === 0) return null;
  return (
    <section aria-label="Lifecycle subscribers" className="mt-3">
      <h3 className="text-[10px] uppercase tracking-wider text-dim">Lifecycle subscribers</h3>
      <ul className="mt-1 flex flex-col gap-1">
        {deliveries.map((delivery) => {
          const known = delivery.state === 'failed' ? errors?.get(delivery.subscriber) : undefined;
          const d =
            known !== undefined && delivery.error === undefined
              ? { ...delivery, error: known }
              : delivery;
          return (
            <li
              key={d.subscriber}
              className="flex flex-wrap items-center gap-1.5"
              data-state={d.state}
            >
              <span className="mono text-[12px] text-fg">{d.subscriber}</span>
              <Chip
                variant={
                  d.state === 'owed' ? 'warn' : d.state === 'failed' ? 'destructive' : 'neutral'
                }
                className="text-[10px]"
                title={
                  d.state === 'not-started'
                    ? NOT_STARTED_TITLE
                    : d.state === 'failed'
                      ? FAILED_TITLE
                      : d.orphanAt !== undefined
                        ? ORPHAN_TITLE
                        : undefined
                }
              >
                {deliveryNote(d, now)}
              </Chip>
              {d.runId && <RunChip runId={d.runId} onOpenRun={onOpenRun} />}
              {d.state === 'started' && <RunStatusChip status={d.status} />}
              {d.state === 'failed' && d.error === undefined && (
                <span className="text-[10px] text-dim">
                  see the run.trigger_failed event for the reason
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The run list's "lifecycle pending" filter: a chip that adds or removes the
 * {@link LIFECYCLE_PENDING_TAG} tag predicate, so an operator finds the settled runs whose
 * lifecycle event is still owed.
 */
export function LifecyclePendingFilter({
  tags,
  onChange,
}: {
  tags: readonly string[];
  onChange: (tags: string[]) => void;
}) {
  const on = tags.includes(LIFECYCLE_PENDING_TAG);
  return (
    <Button
      variant="ghost"
      size="micro"
      aria-pressed={on}
      title="Settled runs whose lifecycle event is still owed to a subscriber (tag durable:lifecycle:pending)"
      onClick={() =>
        onChange(
          on ? tags.filter((t) => t !== LIFECYCLE_PENDING_TAG) : [...tags, LIFECYCLE_PENDING_TAG],
        )
      }
      className={cn(
        'mono rounded-md border-line',
        on && 'border-warn/40 bg-warn/10 text-warn hover:text-warn',
      )}
    >
      lifecycle pending
    </Button>
  );
}

import { useSyncExternalStore } from 'react';
import { Badge as Chip } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import type { EngineEvent, LifecycleDelivery } from '../client/durable-client';
import { EVENT_TAIL_LIMIT, type EventTail, type TailedEvent } from '../client/event-tail';
import { childRunIdOf } from './child-link';
import { LifecycleDeliveries } from './RunLifecycle';
import { parentRunIdOf } from './run-lineage';

/** A link from one event to another run, and which way it points. */
export interface EventLink {
  /** `triggered`: a run this one's settling started; `source`: the run whose settling started this
   *  one; `child` / `parent`: the run's child or parent. */
  rel: 'triggered' | 'source' | 'child' | 'parent';
  runId: string;
}

/**
 * The run whose settling started `runId`, read from a lifecycle subscriber's run id
 * (`evt:<source>:<kind>:<workflow>`), or undefined for any other run.
 */
export function lifecycleSourceRunId(
  runId: string,
  workflow: string | undefined,
): string | undefined {
  if (!workflow || !runId.startsWith('evt:')) return undefined;
  for (const kind of ['completed', 'failed'] as const) {
    const suffix = `:${kind}:${workflow}`;
    if (runId.endsWith(suffix) && runId.length > 'evt:'.length + suffix.length) {
      return runId.slice('evt:'.length, -suffix.length);
    }
  }
  return undefined;
}

/** The runs an event links to: the run a lifecycle event started, a lifecycle subscriber's source,
 *  a child step's run, and a child run's parent. */
export function eventLinks(event: EngineEvent): EventLink[] {
  const links: EventLink[] = [];
  if (event.type === 'run.triggered' && event.triggeredRunId) {
    links.push({ rel: 'triggered', runId: event.triggeredRunId });
  }
  if (event.type === 'run.started') {
    const source = lifecycleSourceRunId(event.runId, event.workflow);
    if (source) links.push({ rel: 'source', runId: source });
    const parent = parentRunIdOf(event.runId);
    if (parent) links.push({ rel: 'parent', runId: parent });
  }
  if (event.type.startsWith('step.') && event.name) {
    const child = childRunIdOf({ name: event.name });
    if (child) links.push({ rel: 'child', runId: child });
  }
  return links;
}

/** What one event row says after its type: the subject (step, subscriber, handler) and why it failed. */
export function eventSummary(event: EngineEvent): string {
  const parts: string[] = [];
  if (event.name) {
    parts.push(
      event.type === 'run.triggered' || event.type === 'run.trigger_failed'
        ? `subscriber ${event.name}`
        : event.type === 'run.routed'
          ? `handler ${event.name}`
          : event.name,
    );
  }
  if (event.durationMs !== undefined) parts.push(`${event.durationMs}ms`);
  if (event.error?.message) parts.push(event.error.message);
  if (event.reason) parts.push(event.reason);
  return parts.join(' · ');
}

/** The subscribers a `run.trigger_failed` in the tail names, with the last error seen for each. */
export function triggerFailures(events: readonly TailedEvent[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const { event } of events) {
    if (event.type === 'run.trigger_failed' && event.name) {
      errors.set(event.name, event.error?.message ?? 'unknown error');
    }
    if (event.type === 'run.triggered' && event.name) errors.delete(event.name);
  }
  return errors;
}

/** The events of `tail`, re-rendering only the caller on each push. */
export function useEventTail(tail: EventTail): readonly TailedEvent[] {
  return useSyncExternalStore(tail.subscribe, tail.snapshot, tail.snapshot);
}

const LINK_LABEL: Record<EventLink['rel'], string> = {
  triggered: 'started',
  source: 'started by',
  child: 'child',
  parent: 'child of',
};

function timeOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toISOString().slice(11, 23);
}

/**
 * The run's engine events as they arrive over the live stream while the page is open, newest first,
 * the last {@link EVENT_TAIL_LIMIT} of them. Nothing is stored or fetched: a reload starts empty.
 */
export function RunEvents({
  tail,
  onOpenRun,
}: {
  tail: EventTail;
  onOpenRun: (id: string) => void;
}) {
  const events = useEventTail(tail);
  return (
    <section aria-label="Events" className="mt-3" data-testid="run-events">
      <h3 className="text-[10px] uppercase tracking-wider text-dim">
        Events{events.length > 0 ? ` · ${events.length}` : ''}
      </h3>
      {events.length === 0 ? (
        <p className="mt-1 text-[11px] text-dim">
          Live only: the engine events of this run show here as they arrive while the page is open
          (the last {tail.limit}). Nothing is stored, so earlier events are not shown.
        </p>
      ) : (
        <ol className="mt-1 flex max-h-72 flex-col gap-0.5 overflow-auto">
          {[...events].reverse().map(({ id, event }) => (
            <li
              key={id}
              className="flex flex-wrap items-center gap-1.5 text-[11px]"
              data-type={event.type}
            >
              <span className="mono text-dim">{timeOf(event.at)}</span>
              <Chip
                variant={
                  event.type === 'run.trigger_failed' ||
                  event.type.endsWith('.failed') ||
                  event.type === 'run.unrouted'
                    ? 'destructive'
                    : 'neutral'
                }
                className="mono"
              >
                {event.type}
              </Chip>
              <span className="text-fg-2">{eventSummary(event)}</span>
              {eventLinks(event).map((link) => (
                <span key={`${link.rel}:${link.runId}`} className="flex items-center gap-1">
                  <span className="text-[10px] text-faint">{LINK_LABEL[link.rel]}</span>
                  <Button
                    variant="chip"
                    size="micro"
                    onClick={() => onOpenRun(link.runId)}
                    className="mono max-w-[24rem] truncate px-1.5 py-0"
                    title={link.runId}
                  >
                    {link.runId}
                  </Button>
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * {@link LifecycleDeliveries} with the reason of each `failed` subscriber filled in from the
 * `run.trigger_failed` events the live tail saw, since the run row does not store it.
 */
export function LiveLifecycleDeliveries({
  deliveries,
  tail,
  onOpenRun,
}: {
  deliveries: readonly LifecycleDelivery[];
  tail: EventTail;
  onOpenRun: (id: string) => void;
}) {
  const events = useEventTail(tail);
  return (
    <LifecycleDeliveries
      deliveries={deliveries}
      errors={triggerFailures(events)}
      onOpenRun={onOpenRun}
    />
  );
}

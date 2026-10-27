import { useQueries, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FanSummary, RunDetail, StepCheckpoint, WorkflowRun } from '../client/durable-client';
import { durableClient, isStalePending } from '../client/durable-client';
import { FAN_PAGE_SIZE, fanPagesInView } from '../client/fan-pages';
import { stepDisplayName } from '../client/folded-children';
import {
  fanProgress,
  fanSizeLabel,
  fanStatus,
  groupParallelSpans,
  runFinished,
} from '../client/group-parallel-spans';
import { groupSubProcesses } from '../client/group-subprocesses';
import { childDetailIds, childFallbackLabel, childRunIdOf, detailsById } from './child-link';
import { FAN_PROGRESS_SEGMENTS } from './fan-progress-style';
import { ChildIcon, iconFor } from './icons';
import { childRunPollInterval } from './run-polling';
import { stalePendingView } from './stale-liveness';

/** Stable empty list, so a run without summarized fans keeps the node memo's input identity. */
const NO_FANS: FanSummary[] = [];

/** Fetch the RunDetail of the first child-ref steps in a timeline (see {@link childDetailIds}), so a
 *  row can read the child's real workflow name (instead of the raw `signal:child:<id>` checkpoint)
 *  and its full run duration. */
function useChildRuns(timeline: StepCheckpoint[]): Record<string, RunDetail> {
  const ids = useMemo(() => childDetailIds(timeline), [timeline]);
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ['run', id],
      queryFn: () => durableClient.run(id),
      refetchInterval: childRunPollInterval,
    })),
    combine: detailsById,
  });
}

/**
 * The wall-clock window [start, end] a step's bar should cover — matching what the rest of the UI
 * reports: a child-ref step → the child run's own window (full duration, not the instant signal
 * checkpoint); a fan-out step → its sub-process span (min start → max end); else the step's own
 * [startedAt, finishedAt].
 */
function barWindow(
  step: StepCheckpoint,
  childRun: RunDetail | undefined,
  liveNow: number,
): [number, number] {
  if (childRun) {
    const created = new Date(childRun.run.createdAt).getTime();
    const open = childRun.run.status === 'running' || childRun.run.status === 'suspended';
    const end = open ? liveNow : new Date(childRun.run.updatedAt).getTime();
    return [created, Math.max(end, created)];
  }
  const { subs } = groupSubProcesses(step.events ?? []);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const sub of subs) {
    if (sub.startedAt !== undefined) start = Math.min(start, sub.startedAt);
    const subEnd = sub.terminal?.at ?? sub.startedAt;
    if (subEnd !== undefined) end = Math.max(end, subEnd);
  }
  if (start !== Number.POSITIVE_INFINITY && end !== Number.NEGATIVE_INFINITY) return [start, end];
  return [new Date(step.startedAt).getTime(), new Date(step.finishedAt).getTime()];
}

/** The window every bar of a run's timeline is placed in: `t0` is the left edge, `span` its width. */
type Frame = { t0: number; span: number; liveNow: number };

/**
 * The wall-clock frame of a run's timeline: from the run's creation (or its earliest bar) to its
 * latest bar, or now while it is live. Summarized fans count by their own start/finish.
 */
function timelineFrame(
  run: WorkflowRun,
  windows: readonly [number, number][],
  fans: readonly FanSummary[],
): Frame {
  const live = run.status === 'running' || run.status === 'suspended';
  const liveNow = Date.now();
  let t0 = new Date(run.createdAt).getTime();
  let tEnd = Number.NEGATIVE_INFINITY;
  for (const [start, end] of windows) {
    t0 = Math.min(t0, start);
    tEnd = Math.max(tEnd, end);
  }
  for (const fan of fans) {
    if (fan.startedAt) t0 = Math.min(t0, new Date(fan.startedAt).getTime());
    if (fan.finishedAt) tEnd = Math.max(tEnd, new Date(fan.finishedAt).getTime());
  }
  tEnd = Math.max(tEnd, live ? liveNow : t0 + 1);
  return { t0, span: Math.max(tEnd - t0, 1), liveNow };
}

/** A step's row: its bar placed in `frame`, plus a bar per sub-process at its own window. */
function prepareRow(
  step: StepCheckpoint,
  childRun: RunDetail | undefined,
  frame: Frame,
  window: [number, number] = barWindow(step, childRun, frame.liveNow),
): PreparedRow {
  const { t0, span } = frame;
  const [barStart, barEnd] = window;
  const { subs } = groupSubProcesses(step.events ?? []);
  const subRows = subs.map((sub) => {
    const start = sub.startedAt ?? barStart;
    const end = sub.terminal?.at ?? start;
    return {
      key: sub.id,
      name: sub.name,
      status: (sub.status ?? 'ok') as SubStatus,
      left: ((start - t0) / span) * 100,
      width: Math.max(((end - start) / span) * 100, 0.8),
      ms: sub.durationMs ?? Math.max(end - start, 0),
    };
  });
  return {
    step,
    childId: childRunIdOf(step),
    childRun,
    left: ((barStart - t0) / span) * 100,
    width: Math.max(((barEnd - barStart) / span) * 100, 0.8),
    ms: barEnd - barStart,
    subRows,
  };
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

type SubStatus = 'ok' | 'failed' | 'skipped';
const SUB_BAR: Record<SubStatus, string> = {
  ok: 'bg-emerald-500/40 ring-1 ring-emerald-500/50',
  failed: 'bg-red-500/40 ring-1 ring-red-500/50',
  skipped: 'bg-amber-500/35 ring-1 ring-amber-500/45',
};
const SUB_DOT: Record<SubStatus, string> = {
  ok: 'bg-emerald-400',
  failed: 'bg-red-400',
  skipped: 'bg-amber-400',
};

/** A prepared timeline row: a step plus its resolved bar geometry and sub-process rows. */
type PreparedRow = {
  step: StepCheckpoint;
  childId: string | undefined;
  childRun: RunDetail | undefined;
  left: number;
  width: number;
  ms: number;
  subRows: {
    key: string;
    name: string;
    status: SubStatus;
    left: number;
    width: number;
    ms: number;
  }[];
};

/**
 * A single step row in the timeline — its name/icon column plus its duration bar, with optional
 * sub-process waterfall and inline child-run expansion. Promoted from an inline closure so its
 * inputs are explicit props rather than captured from `RunSpans`'s body; the rendered output is
 * unchanged.
 */
function StepRow({
  row,
  run,
  childRuns,
  depth,
  selectedKey,
  onSelect,
  onOpenRun,
  onToggleChild,
  expanded,
  collapsedSubs,
  toggleSubs,
}: {
  row: PreparedRow;
  run: WorkflowRun;
  childRuns: Record<string, RunDetail>;
  depth: number;
  selectedKey?: string | undefined;
  onSelect: (step: StepCheckpoint, run: WorkflowRun) => void;
  onOpenRun: (id: string) => void;
  onToggleChild: (childRunId: string) => void;
  expanded: Set<string>;
  collapsedSubs: Set<number>;
  toggleSubs: (seq: number) => void;
}) {
  const { step, left, width, ms, subRows } = row;
  const failed = step.status === 'failed';
  const childRunId = childRunIdOf(step);
  const isChild = !!childRunId;
  const Icon = isChild ? ChildIcon : iconFor(step.kind);
  const active = selectedKey === `${step.runId}#${step.seq}`;
  const isExpanded = isChild && childRunId !== undefined && expanded.has(childRunId);
  const hasSubs = subRows.length > 0 && !isChild;
  const subsCollapsed = collapsedSubs.has(step.seq);
  // A remote step pending past the stale window is EITHER a long-running step still held by a live
  // worker (wait) or a lost dispatch (re-dispatch) — resolve which by consulting the group's worker
  // heartbeats instead of the wall clock alone. Shares the `['workers']` cache with the pods panel;
  // only fetched while a stale row is actually on screen.
  const stale = isStalePending(step, Date.now());
  const { data: workersHealth } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 10_000,
    enabled: stale,
  });
  const staleView = stale
    ? stalePendingView(
        step,
        workersHealth?.find((g) => g.group === step.workerGroup),
        Date.now(),
      )
    : undefined;
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(step, run)}
        title={isChild ? 'Child workflow — click for its detail (↗ opens its run)' : undefined}
        className={`group grid w-full grid-cols-[150px_1fr] items-center gap-3 rounded-md px-2 py-1 text-left transition-colors ${
          active ? 'bg-zinc-800/60' : 'hover:bg-zinc-900/60'
        }`}
      >
        <span className="flex items-center gap-1.5 truncate">
          {isChild && childRunId !== undefined && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleChild(childRunId);
              }}
              className="shrink-0 text-indigo-400 hover:text-indigo-200 transition-colors"
              title={isExpanded ? 'Collapse child run' : 'Expand child run inline'}
            >
              <span
                className="inline-block transition-transform"
                style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▸
              </span>
            </button>
          )}
          {hasSubs && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleSubs(step.seq);
              }}
              className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-300"
              title={
                subsCollapsed ? `Show ${subRows.length} sub-process(es)` : 'Hide sub-processes'
              }
            >
              <span
                className="inline-block transition-transform"
                style={{ transform: subsCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
              >
                ▸
              </span>
            </button>
          )}
          <span
            className={failed ? 'text-red-400' : isChild ? 'text-indigo-300' : 'text-emerald-400'}
          >
            <Icon width={12} height={12} />
          </span>
          <span className="truncate text-[12px] text-zinc-300">
            {childRunId !== undefined
              ? (childRuns[childRunId]?.run.workflow ?? childFallbackLabel(childRunId, run.id))
              : stepDisplayName(step)}
          </span>
          {isChild && childRunId !== undefined && (
            <button
              type="button"
              onClick={(e) => {
                // Navigate to the child run — the row body click opens this step's detail.
                e.stopPropagation();
                onOpenRun(childRunId);
              }}
              title="Open the child run"
              className="shrink-0 text-indigo-300 transition-colors hover:text-indigo-100"
            >
              ↗
            </button>
          )}
        </span>
        <span className="relative h-5">
          {/* track */}
          <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-soft" />
          <span
            className={`absolute top-1/2 flex h-3.5 -translate-y-1/2 items-center rounded-[3px] transition-all duration-500 ease-out ${
              failed
                ? 'bg-red-500/35 ring-1 ring-red-500/50'
                : active
                  ? 'bg-emerald-400/45 ring-1 ring-emerald-400/60'
                  : 'bg-emerald-500/30 ring-1 ring-emerald-500/40'
            }`}
            style={{ left: `${left}%`, width: `${width}%` }}
          />
          <span
            className="mono tnum absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-1 text-[10px] text-zinc-500"
            style={{ left: `min(${left + width}%, calc(100% - 44px))` }}
          >
            {fmtDur(ms)}
          </span>
        </span>
      </button>
      {staleView?.kind === 'working' && (
        <div
          className="mono ml-[18px] mb-1 flex items-center gap-1 text-[10px] text-emerald-500/80"
          title="A live worker holds this dispatch — its heartbeat is fresh. Long steps are expected to sit here; only re-dispatch if the heartbeat goes stale."
        >
          <span aria-hidden>⚙</span>
          being worked by {staleView.instanceId} — heartbeat {staleView.beatAgoS}s ago
          {staleView.inFlight !== undefined ? ` · ${staleView.inFlight} in flight` : ''}
        </div>
      )}
      {staleView?.kind === 'lost' && (
        <div
          className="mono ml-[18px] mb-1 flex items-center gap-1 text-[10px] s-stale"
          title="No live worker heartbeat on this step's group — reconcile-wake can't recover a stuck `pending` step; re-dispatch it from the run actions above"
        >
          <span aria-hidden>⚠</span>
          awaiting worker result — dispatched {staleView.minutes}m ago, no live worker (possibly
          lost)
        </div>
      )}
      {subRows.length > 0 && !subsCollapsed && (
        <div className="ml-[18px] mt-0.5 mb-1 space-y-0.5 border-l border-line-soft pl-2">
          {subRows.map((sub) => (
            <div
              key={sub.key}
              className="grid grid-cols-[130px_1fr] items-center gap-3 px-2"
              title={`${sub.name} — ${sub.status}`}
            >
              <span className="flex items-center gap-1.5 truncate">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SUB_DOT[sub.status]}`} />
                <span className="truncate text-[10px] text-zinc-400">{sub.name}</span>
              </span>
              <span className="relative h-3">
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-soft" />
                <span
                  className={`absolute top-1/2 h-2 -translate-y-1/2 rounded-[2px] transition-all duration-500 ease-out ${SUB_BAR[sub.status]}`}
                  style={{ left: `${sub.left}%`, width: `${sub.width}%` }}
                />
                <span
                  className="mono tnum absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-1 text-[9px] text-zinc-600"
                  style={{ left: `min(${sub.left + sub.width}%, calc(100% - 38px))` }}
                >
                  {fmtDur(sub.ms)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {isChild && childRunId !== undefined && isExpanded && (
        <div className="ml-[18px] mt-0.5 mb-1 border-l border-line-soft pl-2">
          <ChildSpans
            id={childRunId}
            depth={depth + 1}
            selectedKey={selectedKey}
            onSelect={onSelect}
            onOpenRun={onOpenRun}
            expanded={expanded}
            onToggleChild={onToggleChild}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A parallel fan-out (`ctx.gather`/`ctx.all`): a labelled group header over its N member steps laid
 * out as same-level siblings, each an ordinary `StepRow`, to read as "these N ran in parallel".
 * Extracted from the inline fan block in `RunSpans` with no change to the rendered output.
 */
function ParallelFan({
  label,
  fanFailed,
  memberRows,
  rowProps,
}: {
  label: string;
  fanFailed: boolean;
  memberRows: PreparedRow[];
  rowProps: RowProps;
}) {
  return (
    <div className="rounded-md bg-zinc-900/30 ring-1 ring-line-soft">
      <div className="flex items-center gap-2 px-2 py-1">
        <span
          className="text-[11px] text-indigo-300/80"
          title="parallel fan-out (ctx.gather / ctx.all)"
        >
          ⑃
        </span>
        <span className="mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">parallel</span>
        <span className={`text-[11px] ${fanFailed ? 'text-red-400' : 'text-zinc-300'}`}>
          {label}
        </span>
      </div>
      <div className="ml-[10px] border-l border-line-soft pl-1">
        {memberRows.map((row) => (
          <StepRow key={row.step.seq} row={row} {...rowProps} />
        ))}
      </div>
    </div>
  );
}

type RowProps = Omit<React.ComponentProps<typeof StepRow>, 'row'>;

/** A member row's height before it is measured (a row grows when its sub-processes show). */
const MEMBER_ROW_PX = 28;

/**
 * A fan too wide to list, drawn from its {@link FanSummary}: a header with its size and time span, a
 * per-status progress bar, the server's sample of failed members as ordinary rows, and on demand the
 * full member list ({@link FanMembers}), paged in as it scrolls.
 */
function SummarizedFan({
  fan,
  frame,
  rowProps,
}: {
  fan: FanSummary;
  frame: Frame;
  rowProps: RowProps;
}) {
  const [open, setOpen] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const done = runFinished(rowProps.run.status);
  const progress = fanProgress(fan, done);
  const status = fanStatus(fan, done);
  const inFlight = status === 'running' || status === 'pending';
  const runLive = rowProps.run.status === 'running' || rowProps.run.status === 'suspended';
  const start = fan.startedAt ? new Date(fan.startedAt).getTime() : undefined;
  const end = fan.finishedAt
    ? new Date(fan.finishedAt).getTime()
    : inFlight && runLive
      ? frame.liveNow
      : start;
  const failureRows = useMemo(
    () => fan.failures.map((step) => prepareRow(step, undefined, frame)),
    [fan.failures, frame],
  );
  return (
    <div className="rounded-md bg-zinc-900/30 ring-1 ring-line-soft">
      <div className="grid grid-cols-[150px_1fr] items-center gap-3 px-2 py-1">
        <span className="flex items-center gap-1.5 truncate">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-zinc-500 transition-colors hover:text-zinc-300"
            title={open ? 'Hide the members' : `List the ${fan.size} members started`}
          >
            <span
              className="inline-block transition-transform"
              style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
            >
              ▸
            </span>
          </button>
          <span className="text-[11px] text-indigo-300/80" title="parallel fan-out, summarized">
            ⑃
          </span>
          <span
            className={`truncate text-[12px] ${status === 'failed' ? 'text-red-400' : 'text-zinc-300'}`}
            title={fan.group}
          >
            {fan.label} ×{progress.total}
          </span>
        </span>
        <span className="relative h-5">
          <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line-soft" />
          {start !== undefined && end !== undefined && (
            <>
              <span
                className={`absolute top-1/2 h-3.5 -translate-y-1/2 rounded-[3px] ${
                  status === 'failed'
                    ? 'bg-red-500/25 ring-1 ring-red-500/40'
                    : 'bg-indigo-500/20 ring-1 ring-indigo-500/40'
                } ${inFlight ? 'pulse' : ''}`}
                style={{
                  left: `${((start - frame.t0) / frame.span) * 100}%`,
                  width: `${Math.max(((end - start) / frame.span) * 100, 0.8)}%`,
                }}
              />
              <span
                className="mono tnum absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-1 text-[10px] text-zinc-500"
                style={{
                  left: `min(${((end - frame.t0) / frame.span) * 100}%, calc(100% - 44px))`,
                }}
              >
                {fmtDur(end - start)}
              </span>
            </>
          )}
        </span>
      </div>
      <div className="flex items-center gap-3 px-2 pb-1.5 pl-[26px]">
        <span className="flex h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-zinc-800">
          {FAN_PROGRESS_SEGMENTS.map((seg) =>
            progress[seg.key] > 0 ? (
              <span
                key={seg.key}
                className={seg.className}
                style={{ width: `${(progress[seg.key] / Math.max(progress.total, 1)) * 100}%` }}
              />
            ) : null,
          )}
        </span>
        <span className="mono tnum flex flex-wrap gap-2 text-[10px]">
          {progress.started < progress.total && (
            <span className="text-zinc-400">{fanSizeLabel(progress)} started</span>
          )}
          {FAN_PROGRESS_SEGMENTS.map((seg) =>
            progress[seg.key] > 0 ? (
              <span key={seg.key} className={seg.text}>
                {progress[seg.key]} {seg.label}
                {seg.key === 'skipped' && fan.failFast ? ' (failFast)' : ''}
              </span>
            ) : null,
          )}
        </span>
      </div>
      {failureRows.length > 0 && !open && (
        <div className="ml-[10px] border-l border-red-500/30 pl-1">
          <div className="mono px-2 text-[10px] text-red-300/70">
            {progress.failed > failureRows.length
              ? `first ${failureRows.length} of ${progress.failed} failed`
              : `${failureRows.length} failed`}
          </div>
          {failureRows.map((row) => (
            <StepRow key={row.step.seq} row={row} {...rowProps} />
          ))}
        </div>
      )}
      {open && (
        <div className="ml-[10px] border-l border-line-soft pl-1">
          <div className="flex items-center gap-2 px-2 py-0.5">
            <button
              type="button"
              onClick={() => setFailedOnly((v) => !v)}
              className={`mono rounded border px-1.5 text-[10px] transition-colors ${
                failedOnly
                  ? 'border-red-500/40 bg-red-500/15 text-red-300'
                  : 'border-line text-zinc-500 hover:text-zinc-300'
              }`}
            >
              failed only
            </button>
          </div>
          <FanMembers
            key={failedOnly ? 'failed' : 'all'}
            group={fan.group}
            failedOnly={failedOnly}
            live={inFlight && runLive}
            frame={frame}
            rowProps={rowProps}
          />
        </div>
      )}
    </div>
  );
}

/**
 * A summarized fan's members as a virtualized list. Only the pages under the visible rows are
 * fetched (and, while the fan is in flight, refreshed); a row whose page has not landed yet shows a
 * placeholder. Members never fetch their child run's detail: a child row reads by id.
 */
function FanMembers({
  group,
  failedOnly,
  live,
  frame,
  rowProps,
}: {
  group: string;
  failedOnly: boolean;
  live: boolean;
  frame: Frame;
  rowProps: RowProps;
}) {
  const runId = rowProps.run.id;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky: while a newly scrolled-to page is in flight no result carries a total, and dropping the
  // count then would collapse the list under the scroll.
  const [total, setTotal] = useState<number>();
  const virtualizer = useVirtualizer({
    count: total ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => MEMBER_ROW_PX,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 10,
  });
  const items = virtualizer.getVirtualItems();
  const pages = fanPagesInView(items[0]?.index, items[items.length - 1]?.index);
  const results = useQueries({
    queries: pages.map((page) => ({
      queryKey: ['fan', runId, group, failedOnly, page],
      queryFn: () =>
        durableClient.fanMembers(runId, group, {
          offset: page * FAN_PAGE_SIZE,
          limit: FAN_PAGE_SIZE,
          failed: failedOnly,
        }),
      refetchInterval: live ? 5000 : (false as const),
    })),
  });
  const fetchedTotal = results.find((r) => r.data !== undefined)?.data?.total;
  useEffect(() => {
    if (fetchedTotal !== undefined) setTotal(fetchedTotal);
  }, [fetchedTotal]);
  const resultAt = (index: number) => {
    const at = pages.indexOf(Math.floor(index / FAN_PAGE_SIZE));
    return at < 0 ? undefined : results[at];
  };
  const memberAt = (index: number): StepCheckpoint | undefined =>
    resultAt(index)?.data?.items[index % FAN_PAGE_SIZE];

  const failedPage = results.find((r) => r.isError);
  if (total === undefined && failedPage) {
    return (
      <div className="mono px-2 py-1 text-[10px] text-red-400">
        couldn't load members:{' '}
        {failedPage.error instanceof Error ? failedPage.error.message : String(failedPage.error)}
      </div>
    );
  }
  if (total === undefined) {
    return <div className="mono px-2 py-1 text-[10px] text-zinc-600">loading members…</div>;
  }
  if (total === 0) {
    return (
      <div className="mono px-2 py-1 text-[10px] text-zinc-600">
        {failedOnly ? 'no failed members' : 'no members'}
      </div>
    );
  }
  return (
    <div ref={scrollRef} className="max-h-[320px] overflow-auto">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const step = memberAt(item.index);
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {step ? (
                <StepRow row={prepareRow(step, undefined, frame)} {...rowProps} />
              ) : (
                <FanMemberPlaceholder index={item.index} page={resultAt(item.index)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A fan member whose page has not landed: `loading…`, or the page's error with a retry. A finished
 * run's pages are not polled, so without the retry a failed page would never load.
 */
export function FanMemberPlaceholder({
  index,
  page,
}: {
  index: number;
  page?: { isError: boolean; error: unknown; refetch: () => unknown } | undefined;
}) {
  if (page?.isError) {
    return (
      <div
        className="mono flex items-center gap-2 px-2 text-[10px] leading-7 text-red-400"
        style={{ height: MEMBER_ROW_PX }}
      >
        <span className="truncate">
          #{index + 1} couldn't load:{' '}
          {page.error instanceof Error ? page.error.message : String(page.error)}
        </span>
        <button
          type="button"
          onClick={() => void page.refetch()}
          className="rounded border border-red-500/40 px-1.5 text-red-300 hover:bg-red-500/15"
        >
          retry
        </button>
      </div>
    );
  }
  return (
    <div
      className="mono px-2 text-[10px] leading-7 text-zinc-700"
      style={{ height: MEMBER_ROW_PX }}
    >
      #{index + 1} loading…
    </div>
  );
}

export function RunSpans({
  run,
  timeline,
  fans = NO_FANS,
  depth,
  selectedKey,
  onSelect,
  onOpenRun,
  expanded,
  onToggleChild,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  /** Fans the detail summarized: their members are not in `timeline`. */
  fans?: FanSummary[] | undefined;
  depth: number;
  selectedKey?: string | undefined;
  onSelect: (step: StepCheckpoint, run: WorkflowRun) => void;
  onOpenRun: (id: string) => void;
  expanded: Set<string>;
  onToggleChild: (childRunId: string) => void;
}) {
  const childRuns = useChildRuns(timeline);
  const { frame, rows } = useMemo(() => {
    // Each step's bar window — child run window for a child-ref, sub-process span for a fan-out step,
    // else the step's own window (see barWindow) — so durations match the rest of the UI.
    const liveNow = Date.now();
    const prepared = timeline.map((s) => {
      const childId = childRunIdOf(s);
      const childRun = childId !== undefined ? childRuns[childId] : undefined;
      return { step: s, childRun, window: barWindow(s, childRun, liveNow) };
    });
    const frame = timelineFrame(
      run,
      prepared.map((p) => p.window),
      fans,
    );
    const rows = prepared.map((p) => prepareRow(p.step, p.childRun, frame, p.window));
    return { frame, rows };
  }, [run, timeline, fans, childRuns]);

  // A `ctx.gather`/`ctx.all` fan tags its N siblings with the same `parallelGroup`; group them so the
  // members render at the same indent level under one header (a "ran in parallel" fan), not stacked.
  const nodes = useMemo(() => groupParallelSpans(timeline, fans), [timeline, fans]);
  const rowBySeq = useMemo(() => {
    const map = new Map<number, (typeof rows)[number]>();
    for (const row of rows) map.set(row.step.seq, row);
    return map;
  }, [rows]);

  // Per-step collapse of the sub-process waterfall (a fan-out step can have dozens of p-process rows).
  const [collapsedSubs, setCollapsedSubs] = useState<Set<number>>(new Set());
  const toggleSubs = (seq: number) =>
    setCollapsedSubs((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) {
        next.delete(seq);
      } else {
        next.add(seq);
      }
      return next;
    });

  // Shared inputs every `StepRow` needs, regardless of single-vs-fan placement.
  const rowProps = {
    run,
    childRuns,
    depth,
    selectedKey,
    onSelect,
    onOpenRun,
    onToggleChild,
    expanded,
    collapsedSubs,
    toggleSubs,
  };

  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'single') {
          const row = rowBySeq.get(node.step.seq);
          return row ? <StepRow key={row.step.seq} row={row} {...rowProps} /> : null;
        }
        if (node.kind === 'summary') {
          return (
            <SummarizedFan
              key={`fan:${node.fan.group}`}
              fan={node.fan}
              frame={frame}
              rowProps={rowProps}
            />
          );
        }
        // A parallel fan: lay its member steps out as siblings under one labelled header, each an
        // ordinary `StepRow`, to read as "these N ran in parallel".
        const memberRows = node.steps
          .map((s) => rowBySeq.get(s.seq))
          .filter((r): r is PreparedRow => r !== undefined);
        return (
          <ParallelFan
            key={`fan:${node.group}`}
            label={node.label}
            fanFailed={node.steps.some((s) => s.status === 'failed')}
            memberRows={memberRows}
            rowProps={rowProps}
          />
        );
      })}
    </>
  );
}

function ChildSpans({
  id,
  depth,
  selectedKey,
  onSelect,
  onOpenRun,
  expanded,
  onToggleChild,
}: {
  id: string;
  depth: number;
  selectedKey?: string | undefined;
  onSelect: (step: StepCheckpoint, run: WorkflowRun) => void;
  onOpenRun: (id: string) => void;
  expanded: Set<string>;
  onToggleChild: (childRunId: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['run', id],
    queryFn: () => durableClient.run(id),
    refetchInterval: childRunPollInterval,
  });
  if (depth > 6) return null; // safety cap against pathological nesting
  if (!data)
    return <div className="mono px-2 py-1 text-[10px] text-zinc-600">loading child run…</div>;
  return (
    <div className="my-1 rounded-md border border-line bg-black/15">
      <div className="mono flex items-center gap-2 px-2 py-1 text-[10px] text-zinc-500">
        <span className="text-indigo-300">⌁ {data.run.workflow}</span>
        <span className="tnum text-zinc-600">{id.slice(0, 8)}</span>
        <span className={`s-${data.run.status} uppercase`}>{data.run.status}</span>
        <button
          type="button"
          onClick={() => onOpenRun(id)}
          className="ml-auto rounded border border-line px-1.5 text-zinc-400 hover:text-zinc-200"
        >
          open ↗
        </button>
      </div>
      <RunSpans
        run={data.run}
        timeline={data.timeline}
        fans={data.fans}
        depth={depth}
        selectedKey={selectedKey}
        onSelect={onSelect}
        onOpenRun={onOpenRun}
        expanded={expanded}
        onToggleChild={onToggleChild}
      />
    </div>
  );
}

/**
 * A span waterfall (gantt) for the run: each checkpoint is a bar placed by its start offset and
 * sized by its real duration, so you read at a glance which step took the time. Click to inspect.
 */
export function SpansTimeline({
  run,
  timeline,
  fans,
  selectedKey,
  onSelect,
  onOpenRun,
  expanded,
  onToggleChild,
}: {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  /** Fans the detail summarized: each is one node, its members paged in on demand. */
  fans?: FanSummary[] | undefined;
  /** `${runId}#${seq}` of the selected step. */
  selectedKey?: string | undefined;
  /** Open a step's detail — the step + the run it belongs to. */
  onSelect: (step: StepCheckpoint, run: WorkflowRun) => void;
  /** Navigate to another run — used when a child-workflow row's ↗ is clicked. */
  onOpenRun: (id: string) => void;
  /** Set of child run ids currently expanded inline. */
  expanded?: Set<string> | undefined;
  /** Toggle inline expansion of a child run. */
  onToggleChild?: ((id: string) => void) | undefined;
}) {
  // Compute span total for the top-level run header.
  const span = useMemo(
    () =>
      timelineFrame(
        run,
        timeline.map((s): [number, number] => [
          new Date(s.startedAt).getTime(),
          new Date(s.finishedAt).getTime(),
        ]),
        fans ?? NO_FANS,
      ).span,
    [run, timeline, fans],
  );

  const resolvedExpanded = expanded ?? new Set<string>();
  const resolvedToggle = onToggleChild ?? (() => {});

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">spans</span>
        <span className="mono tnum text-[10px] text-zinc-600">total {fmtDur(span)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-auto px-3 pb-3">
        <RunSpans
          run={run}
          timeline={timeline}
          fans={fans}
          depth={0}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onOpenRun={onOpenRun}
          expanded={resolvedExpanded}
          onToggleChild={resolvedToggle}
        />
      </div>
    </div>
  );
}

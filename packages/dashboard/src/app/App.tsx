import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  deriveRunState,
  durableClient,
  type GroupHealth,
  type RunDetail as RunDetailData,
  type RunDisplayStatus,
  type RunStatus,
  type StepCheckpoint,
  type WorkerStatus,
  type WorkflowRun,
} from '../client/durable-client';
import { groupByPartition, type PartitionView } from '../client/group-by-partition';
import { mergeLiveEvents } from '../client/merge-live-events';
import { pivotByWorker, type WorkerView } from '../client/pivot-by-worker';
import { partitionOf } from '../client/queue-partition';
import {
  ALL_ORIGINS,
  emptyRunsNotice,
  filterByOrigin,
  knownOrigin,
  type OriginFilter,
  originFilterKey,
  originLabel,
  UNKNOWN_ORIGIN,
  UNKNOWN_ORIGIN_TITLE,
  unknownOriginCount,
} from '../client/run-origin';
import {
  compensationDisplayName,
  compensationSummary,
  splitCompensations,
} from '../client/split-compensations';
import { type HealthSummary, summarizeHealth } from '../client/summarize-health';
import { BoltIcon, PlayIcon, RetryIcon, XIcon } from './icons';
import { OriginFacets } from './OriginFacets';
import { RunInfoPanel } from './RunInfoPanel';
import { parentRunIdOf, retryOriginOf } from './run-lineage';
import { SpansTimeline } from './SpansTimeline';
import { StepDetailPanel } from './StepDetailPanel';
import { badgeVariants, Badge as Chip } from './ui/badge';
import { Button } from './ui/button';
import { cn } from './ui/cn';
import { Dialog } from './ui/dialog';
import { InputField } from './ui/input';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tabs, TabsList, TabsPanel, TabsTab } from './ui/tabs';
import { Tooltip, TooltipProvider } from './ui/tooltip';
import { WorkflowGraph } from './WorkflowGraph';

/** The durable brand mark — a workflow glyph: a rounded diamond with three connected nodes (a step
 *  flowing into the next), in currentColor so it inherits the `--accent` token. Replaces the bare `◆`. */
function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="durable"
    >
      <title>durable</title>
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" opacity={0.35} />
      <circle cx="6.4" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="17.6" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <path d="M8.1 12h2.2M13.7 12h2.2" />
    </svg>
  );
}

const STATUSES: RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelling',
  'cancelled',
  'dead',
];

/** Runs fetched per `/runs` page — server caps `limit` at 200 (`handlers.ts`'s `listRuns`); this stays
 *  comfortably under that so a single page fetch is cheap, while still being large enough that most
 *  filtered views never need a second page. */
const RUNS_PAGE_SIZE = 100;

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function durMs(a: string, b: string): string {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function StatusDot({ status }: { status: RunDisplayStatus | StepCheckpoint['status'] }) {
  const live = status === 'running' || status === 'awaiting' || status === 'cancelling';
  return <span className={`dot s-${status} ${live ? 'pulse' : ''}`} aria-hidden />;
}

function Badge({ status }: { status: RunDisplayStatus | StepCheckpoint['status'] }) {
  return (
    <Chip variant="status" className={`s-${status} text-[11px]`}>
      <StatusDot status={status} />
      {status}
    </Chip>
  );
}

function Header({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<string, number>;
  filter: RunStatus | 'all';
  onFilter: (f: RunStatus | 'all') => void;
}) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (key: RunStatus | 'all', label: string, n: number) => (
    <Button
      key={key}
      variant="ghost"
      size="chip"
      aria-pressed={filter === key}
      onClick={() => onFilter(key)}
      className={cn(
        'rounded-md',
        filter === key && 'border-zinc-600 bg-zinc-900 text-zinc-100 hover:text-zinc-100',
      )}
    >
      {key !== 'all' && <StatusDot status={key} />}
      <span className="uppercase tracking-wide">{label}</span>
      <span className="mono tnum text-zinc-600">{n}</span>
    </Button>
  );
  // Topology is fixed for a deployment's lifetime, so fetch once and never refetch.
  const { data: topology } = useQuery({
    queryKey: ['topology'],
    queryFn: () => durableClient.topology(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const isTenant = topology?.role === 'tenant';
  const roleLabel = !topology
    ? ''
    : isTenant
      ? topology.tenant
        ? `tenant · ${topology.tenant}`
        : 'tenant'
      : 'control plane';
  return (
    <header className="z-10 flex items-center gap-4 border-b border-line px-5 py-3">
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 place-items-center rounded-md border border-brand/30 bg-brand/10">
          <LogoMark className="h-4 w-4 text-brand" />
        </div>
        <div className="leading-none">
          <div className="text-sm font-semibold tracking-tight">durable</div>
          <div
            className={`mono text-[10px] uppercase tracking-[0.2em] ${
              isTenant ? 'text-amber-400/80' : 'text-zinc-600'
            }`}
            title={
              isTenant
                ? `Tenant deployment — partition ${topology?.tenant ?? '(unnamed)'}`
                : 'Control-plane deployment'
            }
          >
            {roleLabel}
          </div>
        </div>
      </div>
      <div className="ml-2 flex flex-wrap items-center gap-1">
        {chip('all', 'all', total)}
        {STATUSES.map((s) => chip(s, s, counts[s] ?? 0))}
      </div>
      <WorkersHealth />
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span className="dot s-completed pulse" aria-hidden />
        live
      </div>
    </header>
  );
}

/** Compact "Nm ago" relative stamp for an epoch-ms instant. */
function relAgoMs(atMs: number): string {
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
function WorkerStatusCells({ status }: { status: WorkerStatus | undefined }) {
  const c = status?.concurrency;
  if (!status || !c) {
    return <span className="mono text-[9px] text-zinc-600">no status</span>;
  }
  const saturated = c.limit > 0 && status.inFlight >= c.limit * 0.8;
  return (
    <div className="flex flex-col gap-1">
      <div className="mono flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
        <span
          className={`shrink-0 rounded border px-1 text-[9px] uppercase tracking-wider ${
            c.mode === 'adaptive'
              ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
              : 'border-zinc-600/50 bg-zinc-800/60 text-zinc-400'
          }`}
        >
          {c.mode === 'adaptive' ? `adaptive ${c.min ?? 1}–${c.max ?? 32}` : 'fixed'}
        </span>
        <span className={saturated ? 'text-amber-300' : 'text-zinc-400'}>
          in-flight{' '}
          <span className="tnum">
            {status.inFlight}/{c.limit}
          </span>
        </span>
        {typeof status.rssPct === 'number' && (
          <span className={status.rssPct >= 85 ? 'text-rose-300' : ''}>
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
        <div className="mono text-[10px] text-zinc-500">
          {status.lastAdjust.reason}{' '}
          <span className="tnum text-zinc-400">
            {status.lastAdjust.from}→{status.lastAdjust.to}
          </span>{' '}
          {relAgoMs(status.lastAdjust.at)}
        </div>
      )}
    </div>
  );
}

/** Per-worker rows for an expanded group: each live worker's id + its {@link WorkerStatusCells}. */
function WorkerRows({ workers }: { workers: GroupHealth['liveWorkers'] }) {
  return (
    <div className="flex flex-col divide-y divide-line-soft">
      {workers.map((w) => (
        <div key={w.instanceId} className="flex flex-col gap-1 px-2.5 py-2">
          <span className="mono truncate text-[10px] text-zinc-400">{w.instanceId}</span>
          <WorkerStatusCells status={w.status} />
        </div>
      ))}
    </div>
  );
}

type WorkersPanelView = 'workers' | 'partitions' | 'alerts';

/**
 * Worker health, three ways (toggle). Route-by-handler makes every `@Step`/`@Workflow` its own queue
 * and one worker serves many, so a per-queue list is noise — these views collapse it onto the axes
 * that actually vary: **workers** (each live pod + what it's serving; the default), **partitions**
 * (the tenant-isolation axis), and **alerts** (only starved queues — `depth > 0` with no worker).
 * Polls `/workers`; renders nothing when the transport can't report health.
 */
function WorkersHealth() {
  const { data } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 10_000,
  });
  const [view, setView] = useState<WorkersPanelView>('workers');
  if (!data || data.length === 0) return null;
  const summary = summarizeHealth(data);
  const label: Record<WorkersPanelView, string> = {
    workers: 'pods',
    partitions: 'parts',
    alerts: 'alerts',
  };
  return (
    <Tabs
      value={view}
      onValueChange={(v) => setView(v as WorkersPanelView)}
      className="ml-auto flex flex-nowrap items-center gap-1.5"
    >
      <TabsList>
        {(['workers', 'partitions', 'alerts'] as const).map((v) => (
          <TabsTab key={v} value={v}>
            {label[v]}
            {v === 'alerts' && summary.starved.length > 0 && (
              <span className="tnum ml-1 rounded bg-rose-500/80 px-1 text-[9px] text-white">
                {summary.starved.length}
              </span>
            )}
          </TabsTab>
        ))}
      </TabsList>
      {/* Fixed-width, right-justified slot: toggling views swaps content inside a stable box, so the
          header never reflows (no wrap to a 2nd line, no width jump). The expand popovers are
          portalled, so they are no longer at the mercy of this box's overflow. */}
      <div className="flex w-[300px] flex-nowrap items-center justify-end gap-1.5">
        <TabsPanel value="workers" className="flex flex-nowrap items-center gap-1.5">
          <WorkersByPod workers={pivotByWorker(data)} />
        </TabsPanel>
        <TabsPanel value="partitions" className="flex flex-nowrap items-center gap-1.5">
          <PartitionsHealth groups={data} />
        </TabsPanel>
        <TabsPanel value="alerts" className="flex flex-nowrap items-center gap-1.5">
          <StarvationAlerts summary={summary} />
        </TabsPanel>
      </div>
    </Tabs>
  );
}

/**
 * Default view: one chip per live worker (pod), with its partition, how many handlers it serves, and
 * its in-flight load. Clicking expands its full status ({@link WorkerStatusCells}) plus the list of
 * handlers it's subscribed to.
 */
// Sentinel `open` key for the "+N" overflow popover (can't collide with any real instanceId).
const OVERFLOW_KEY = '__overflow__';

function loadOf(w: WorkerView): string | undefined {
  const c = w.status?.concurrency;
  return w.status && c ? `${w.status.inFlight}/${c.limit}` : undefined;
}

/** The expanded body for one pod — its live status cells plus the full list of handlers it serves.
 *  Shared by the inline pod chip's popover AND the "+N" overflow popover's expandable rows, so a pod
 *  hidden behind "+N" reveals exactly the same detail as a visible chip. */
function PodDetail({ w }: { w: WorkerView }) {
  return (
    <>
      <div className="px-2.5 py-2">
        <WorkerStatusCells status={w.status} />
      </div>
      <div className="max-h-48 overflow-auto border-t border-line-soft px-2.5 py-1.5">
        <div className="mono mb-1 text-[9px] uppercase tracking-wider text-zinc-600">
          {w.handlers.length} handlers
        </div>
        {w.handlers.map((h) => (
          <div key={h} className="mono truncate text-[10px] text-zinc-400">
            {h}
          </div>
        ))}
      </div>
    </>
  );
}

function WorkersByPod({ workers }: { workers: WorkerView[] }) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  // Which pod is expanded INSIDE the "+N" overflow popover (independent of the inline chips' `open`).
  const [overflowPod, setOverflowPod] = useState<string | undefined>(undefined);
  // Cap inline chips so the pod row can never overflow its fixed slot and paint over the view toggle
  // (long pod instanceIds mean even a couple of full-width chips exceed 300px). The rest collapse into
  // a clickable "+N" chip whose popover lists exactly which pods it hides.
  const MAX_INLINE = 2;
  const visible = workers.slice(0, MAX_INLINE);
  const overflow = workers.slice(MAX_INLINE);
  const overflowOpen = open === OVERFLOW_KEY;
  return (
    <>
      {visible.map((w) => {
        const isOpen = open === w.instanceId;
        const load = loadOf(w);
        return (
          <Popover
            key={w.instanceId}
            open={isOpen}
            onOpenChange={(next) => setOpen(next ? w.instanceId : undefined)}
          >
            <Tooltip
              suppressed={isOpen}
              label={`${w.instanceId}\n${w.handlers.length} handlers · ${w.partition}${load ? ` · ${load} in-flight` : ''}`}
            >
              <PopoverTrigger
                render={
                  <Button
                    variant="chip"
                    size="xs"
                    className={cn(
                      'mono max-w-[120px] gap-1',
                      isOpen && 'border-zinc-500 bg-zinc-800 text-zinc-200',
                    )}
                  >
                    <span className={`dot ${w.status ? 's-completed' : ''}`} aria-hidden />
                    <span className="truncate">{w.instanceId}</span>
                    {w.partition !== 'default' && (
                      <span className="shrink-0 text-zinc-500">@{w.partition}</span>
                    )}
                    <span className="tnum shrink-0 text-zinc-500">
                      {w.handlers.length}h{load ? ` · ${load}` : ''}
                    </span>
                  </Button>
                }
              />
            </Tooltip>
            <PopoverContent>
              <div className="mono flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5 text-[10px] text-zinc-500">
                <span className="truncate text-zinc-300">{w.instanceId}</span>
                <span className="shrink-0">
                  {w.runtime ?? 'node'} · {w.partition}
                </span>
              </div>
              <PodDetail w={w} />
            </PopoverContent>
          </Popover>
        );
      })}
      {overflow.length > 0 && (
        <Popover
          open={overflowOpen}
          onOpenChange={(next) => {
            setOpen(next ? OVERFLOW_KEY : undefined);
            setOverflowPod(undefined);
          }}
        >
          <PopoverTrigger
            render={
              <Button
                variant="chip"
                size="xs"
                className={cn(
                  'mono shrink-0',
                  overflowOpen && 'border-zinc-500 bg-zinc-800 text-zinc-200',
                )}
              >
                +{overflow.length}
              </Button>
            }
          />
          <PopoverContent>
            <div className="mono border-b border-line px-2.5 py-1.5 text-[9px] uppercase tracking-wider text-zinc-600">
              {overflow.length} more {overflow.length === 1 ? 'pod' : 'pods'}
            </div>
            <div className="max-h-80 divide-y divide-line-soft overflow-auto">
              {overflow.map((w) => {
                const load = loadOf(w);
                const podOpen = overflowPod === w.instanceId;
                return (
                  <div key={w.instanceId}>
                    {/* Same click-to-expand as a visible chip: the row toggles the pod's PodDetail. */}
                    <button
                      type="button"
                      onClick={() => setOverflowPod(podOpen ? undefined : w.instanceId)}
                      className={cn(
                        'mono flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[10px] hover:bg-zinc-800/50',
                        podOpen ? 'bg-zinc-800/40 text-zinc-200' : 'text-zinc-300',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        <span className={`dot ${w.status ? 's-completed' : ''}`} aria-hidden />
                        <span className="truncate">{w.instanceId}</span>
                      </span>
                      <span className="tnum shrink-0 text-zinc-500">
                        {w.partition !== 'default' ? `@${w.partition} · ` : ''}
                        {w.handlers.length}h{load ? ` · ${load}` : ''}
                      </span>
                    </button>
                    {podOpen && (
                      <div className="border-t border-line-soft bg-zinc-900/40">
                        <PodDetail w={w} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

/**
 * Partition view: one chip per tenant-isolation partition (`default` = the operator/control plane),
 * with its worker count, handler count, and total queue depth — turning RED when any queue in it is
 * starved. Clicking expands the partition's live workers ({@link WorkerRows}).
 */
function PartitionsHealth({ groups }: { groups: GroupHealth[] }) {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const partitions = groupByPartition(groups);
  function workersOf(partition: string): GroupHealth['liveWorkers'] {
    const seen = new Map<string, GroupHealth['liveWorkers'][number]>();
    for (const g of groups) {
      if (partitionOf(g.group) !== partition) continue;
      for (const w of g.liveWorkers) if (!seen.has(w.instanceId)) seen.set(w.instanceId, w);
    }
    return [...seen.values()];
  }
  return (
    <>
      {partitions.map((p: PartitionView) => {
        const starved = p.starvedCount > 0;
        const isOpen = open === p.partition;
        return (
          <Popover
            key={p.partition}
            open={isOpen && p.workerCount > 0}
            onOpenChange={(next) => setOpen(next ? p.partition : undefined)}
          >
            <Tooltip
              suppressed={isOpen}
              label={`${p.partition}\n${p.workerCount} workers · ${p.handlerCount} handlers · ${p.totalDepth} queued${starved ? ` · ${p.starvedCount} starved` : ''}`}
            >
              <PopoverTrigger
                render={
                  <Button
                    variant="chip"
                    size="xs"
                    disabled={p.workerCount === 0}
                    className={cn(
                      'mono gap-1',
                      starved && 'border-rose-500/50 bg-rose-500/15 text-rose-300',
                      !starved && isOpen && 'border-zinc-500 bg-zinc-800 text-zinc-200',
                      p.workerCount > 0 ? 'cursor-pointer' : 'cursor-default',
                    )}
                  >
                    <span
                      className={`dot ${starved ? 's-failed' : p.workerCount > 0 ? 's-completed' : ''}`}
                      aria-hidden
                    />
                    {p.partition}
                    <span className="tnum text-zinc-500">
                      {p.workerCount}w {p.handlerCount}h
                      {p.totalDepth > 0 ? ` ${p.totalDepth}q` : ''}
                      {starved ? ` ${p.starvedCount}!` : ''}
                    </span>
                  </Button>
                }
              />
            </Tooltip>
            <PopoverContent>
              <div className="mono flex items-center justify-between border-b border-line px-2.5 py-1.5 text-[10px] text-zinc-500">
                <span className="text-zinc-300">{p.partition}</span>
                <span className="tnum">
                  {p.workerCount} worker(s) · {p.totalDepth} queued
                </span>
              </div>
              <WorkerRows workers={workersOf(p.partition)} />
            </PopoverContent>
          </Popover>
        );
      })}
    </>
  );
}

/**
 * Alerts view: the panel's actual purpose distilled — a compact summary plus a red chip for EACH
 * starved queue (`depth > 0 && liveWorkers === 0`, work with no consumer). Nothing but the summary
 * when everything is draining.
 */
function StarvationAlerts({ summary }: { summary: HealthSummary }) {
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  return (
    <>
      <Tooltip
        label={`Route-by-handler: each @Workflow & @Step is served as its own queue.\n${summary.queueCount} queues across ${plural(summary.workerCount, 'worker')}.`}
      >
        <span className="mono tnum text-[10px] text-zinc-500">
          {plural(summary.workflowCount, 'workflow')} · {plural(summary.stepCount, 'step')} ·{' '}
          {plural(summary.workerCount, 'worker')} ·{' '}
          {summary.allDraining ? (
            <span className="text-good">all draining</span>
          ) : (
            <span className="text-rose-300">{summary.starved.length} starved</span>
          )}
        </span>
      </Tooltip>
      {summary.starved.map((g) => (
        <Tooltip key={g.group} label={`${g.group}\n${g.depth} queued, no worker consuming`}>
          <Chip variant="danger" className="mono gap-1 border-rose-500/50 bg-rose-500/15 py-0.5">
            <span className="dot s-failed" aria-hidden />
            <span className="max-w-[180px] truncate">{g.group}</span>
            <span className="tnum shrink-0">{g.depth}q · 0w</span>
          </Chip>
        </Tooltip>
      ))}
    </>
  );
}

/** Placeholder rows shown while the first `/runs` fetch is in flight, so the pane never flashes
 *  "No runs yet." before real data lands. Same row footprint as a real run → no layout jump. */
function RunsListSkeleton() {
  return (
    <ul className="divide-y divide-line-soft" aria-hidden>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="h-3.5 w-32 animate-pulse rounded bg-zinc-800" />
            <div className="h-3 w-16 animate-pulse rounded bg-zinc-800/70" />
          </div>
          <div className="h-2.5 w-48 animate-pulse rounded bg-zinc-800/50" />
        </li>
      ))}
    </ul>
  );
}

/** One run row — extracted out of {@link RunsList} so the virtualizer can measure/position it without
 *  duplicating the markup between the (currently unused-but-kept-obvious) plain path and the virtual
 *  one. Identical visual output to the pre-virtualization row. */
function RunRow({
  r,
  allRuns,
  health,
  selected,
  onSelect,
  onSelectTag,
  onSelectNamespace,
  onSelectOrigin,
}: {
  r: WorkflowRun;
  allRuns: WorkflowRun[];
  health: GroupHealth[];
  selected?: string | undefined;
  onSelect: (id?: string) => void;
  onSelectTag: (tag: string) => void;
  onSelectNamespace: (namespace: string) => void;
  onSelectOrigin: (filter: OriginFilter) => void;
}) {
  const state = deriveRunState(r, { runs: allRuns, health });
  // Bound as consts so the click handlers close over a narrowed value (a property read would
  // widen back to `string | undefined` inside the callback). Both chips are POINTER shortcuts
  // for the sidebar filters, exactly like the tag chips below: a nested <button> would be
  // invalid markup inside the row's own button, so the row stays the keyboard target.
  const tenant = r.namespace && r.namespace !== 'default' ? r.namespace : undefined;
  const origin = knownOrigin(r.origin);
  return (
    <button
      type="button"
      onClick={() => onSelect(r.id)}
      className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors ${
        selected === r.id ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-zinc-200">{r.workflow}</span>
          {tenant && (
            <Chip
              variant="tenant"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-sky-400/60 hover:text-sky-200"
              title={`Tenant / worker-pool partition — click to show only ${tenant}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNamespace(tenant);
              }}
            >
              {tenant}
            </Chip>
          )}
          {/* Origin, when the run HAS one. An unattributed run shows no chip here rather than
              a row of `unknown` noise — the facet above keeps its count on screen, the empty
              state names it, and the run's own detail header states it outright. */}
          {origin && (
            <Chip
              variant="origin"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-teal-400/60 hover:text-teal-200"
              title={`Declared by ${origin} — click to show only this library's runs`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectOrigin({ kind: 'origin', origin });
              }}
            >
              {originLabel(origin)}
            </Chip>
          )}
          {r.id.startsWith('dlq:') && (
            <Chip
              variant="danger"
              className="mono shrink-0 px-1 text-[9px] uppercase tracking-wider"
            >
              dlq
            </Chip>
          )}
        </span>
        <Badge status={state.status} />
      </div>
      {/* WHY it's parked, in domain terms — the signal/webhook/child token, the singleton leader,
        or the handler that has no live worker. Only for the derived waiting states. */}
      {state.detail && (
        <div className={`mono truncate text-[11px] s-${state.status}`}>{state.detail}</div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="mono truncate text-[11px] text-zinc-600">{r.id}</span>
        <span className="shrink-0 text-[11px] text-zinc-600">{relTime(r.updatedAt)}</span>
      </div>
      {r.tags && r.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {r.tags.map((t) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: a nested <button> is invalid inside the row's own button — the row stays the keyboard target, the tag is a pointer shortcut for the same filter the sidebar field applies
            // biome-ignore lint/a11y/noStaticElementInteractions: same reason — the enclosing row button is the interactive element; this span only adds a pointer shortcut
            <span
              key={t}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTag(t);
              }}
              className={cn(
                badgeVariants({ variant: 'outline' }),
                'mono cursor-pointer hover:border-zinc-500 hover:text-zinc-200',
              )}
            >
              #{t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// A row's height varies (tags/chips/detail line all add lines), so this is only the FIRST-PAINT
// guess `measureElement` (below) corrects per row once real content is on screen — same technique
// TanStack's own variable-height examples use.
const RUN_ROW_ESTIMATE_PX = 88;

/** Exported (unlike this file's other internal components) so the virtualization/pagination behavior
 *  below has a direct unit-test surface — see `RunsList.spec.tsx`. */
export function RunsList({
  runs,
  allRuns,
  health,
  loading,
  selected,
  onSelect,
  onSelectTag,
  onSelectNamespace,
  onSelectOrigin,
  emptyNotice,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  runs: WorkflowRun[];
  /** The FULL (unfiltered) run list — needed to place a run among its singleton siblings even when the
   *  leader is filtered out of `runs`. */
  allRuns: WorkflowRun[];
  health: GroupHealth[];
  loading?: boolean;
  selected?: string | undefined;
  onSelect: (id?: string) => void;
  onSelectTag: (tag: string) => void;
  onSelectNamespace: (namespace: string) => void;
  onSelectOrigin: (filter: OriginFilter) => void;
  /** What to say when nothing matched — see `emptyRunsNotice`; an empty list must never read as
   *  "these runs do not exist" when the truth is "this filter cannot match them". */
  emptyNotice: ReturnType<typeof emptyRunsNotice>;
  /** True while the server may still hold more runs matching the current tag/attr/namespace filter
   *  beyond what's been fetched (the last page came back full — see `RunsPage.page`). */
  hasMore?: boolean;
  /** True while a scroll-triggered `/runs?offset=…` fetch is in flight. */
  loadingMore?: boolean;
  /** Fetch the next page. Called once the virtualizer scrolls the last loaded row into view — the
   *  virtualizer already tracks exactly which rows are visible, so this composes for free instead of
   *  a separate IntersectionObserver on a sentinel element. */
  onLoadMore?: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // React keys these rows by run id, so the virtualiser has to key its size and element caches by the
  // same thing. Under its default key — the array index — a surviving run that moves to a different
  // index does not remount, so its measurement is never re-attributed and each index keeps the height
  // of whoever sat there before, putting every row offset and `getTotalSize()` out by that difference.
  // The list's `key` covers filter changes by remounting; this covers what a remount cannot, which is
  // the poll reordering the list in place as one new run arrives and pushes every row down an index.
  // Depends on `runs` on purpose: a contents change under an unchanged count has to invalidate the
  // memoised measurements, and this callback's identity is what does that.
  const getItemKey = useCallback((index: number) => runs[index]?.id ?? index, [runs]);
  const rowVirtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => RUN_ROW_ESTIMATE_PX,
    getItemKey,
    overscan: 10,
    // Seeds a non-zero size before the real ResizeObserver measurement lands, so the very first paint
    // (and a jsdom/happy-dom test harness with no real layout engine) still renders a bounded window
    // instead of either nothing or the whole list.
    initialRect: { width: 340, height: 480 },
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastVisibleIndex =
    virtualItems.length > 0 ? (virtualItems[virtualItems.length - 1]?.index ?? -1) : -1;
  useEffect(() => {
    if (runs.length === 0) return;
    if (lastVisibleIndex < runs.length - 1) return;
    if (!hasMore || loadingMore) return;
    onLoadMore?.();
  }, [lastVisibleIndex, runs.length, hasMore, loadingMore, onLoadMore]);

  if (loading && runs.length === 0) {
    return <RunsListSkeleton />;
  }
  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 p-6 text-sm text-zinc-600">
        <span>{emptyNotice.message}</span>
        {emptyNotice.unclassified !== undefined && (
          <>
            <span className="text-[11px] text-zinc-500">
              {emptyNotice.unclassified} run{emptyNotice.unclassified === 1 ? '' : 's'} here{' '}
              {emptyNotice.unclassified === 1 ? 'has' : 'have'} no recorded origin, so no package
              filter can match {emptyNotice.unclassified === 1 ? 'it' : 'them'}.
            </span>
            <Button
              variant="chip"
              size="xs"
              className="mono rounded"
              title={UNKNOWN_ORIGIN_TITLE}
              onClick={() => onSelectOrigin({ kind: 'unknown' })}
            >
              show unclassified
            </Button>
          </>
        )}
      </div>
    );
  }
  return (
    <div ref={parentRef} className="h-full overflow-auto" data-testid="runs-list-scroll">
      <ul
        className="relative divide-y divide-line-soft"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        {virtualItems.map((vi) => {
          const r = runs[vi.index];
          if (!r) return null;
          return (
            <li
              key={r.id}
              ref={rowVirtualizer.measureElement}
              data-index={vi.index}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <RunRow
                r={r}
                allRuns={allRuns}
                health={health}
                selected={selected}
                onSelect={onSelect}
                onSelectTag={onSelectTag}
                onSelectNamespace={onSelectNamespace}
                onSelectOrigin={onSelectOrigin}
              />
            </li>
          );
        })}
      </ul>
      {loadingMore && (
        <div className="mono px-4 py-2 text-center text-[11px] text-zinc-600">loading more…</div>
      )}
    </div>
  );
}

/** The saga-compensation group, rendered after the body timeline in unwind order (seq -1 first).
 *  Never mixes into the body graph/spans — this is its own amber-accented list. Each row is
 *  clickable into the SAME step-detail panel the body uses (`onSelect` just forwards to it), so a
 *  failed undo's input/output reads exactly like a normal step's. */
function CompensationSection({
  compensations,
  selKey,
  onSelect,
}: {
  compensations: StepCheckpoint[];
  selKey: string | undefined;
  onSelect: (step: StepCheckpoint) => void;
}) {
  return (
    <div className="shrink-0 border-t border-amber-500/20 bg-black/20 px-7 py-3">
      <div className="mono mb-2 text-[10px] uppercase tracking-[0.18em] text-amber-400/80">
        compensation · unwind order
      </div>
      <ul className="flex flex-col gap-1">
        {compensations.map((step) => {
          const key = `${step.runId}#${step.seq}`;
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onSelect(step)}
                className={`mono flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[11.5px] transition-colors ${
                  key === selKey
                    ? 'border-amber-500/50 bg-amber-500/15'
                    : 'border-amber-500/20 bg-amber-500/5 hover:border-amber-500/40'
                }`}
              >
                <StatusDot status={step.status} />
                <span className="truncate text-amber-100">
                  {compensationDisplayName(step.name)}
                </span>
                <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-amber-400/70">
                  {step.status}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RunDetail({ id, onOpenRun }: { id: string; onOpenRun: (id: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['run', id],
    // Merge over the cache instead of replacing it: the store only persists a step's `events` at
    // completion, so a refetch returns a still-running step empty — replacing would wipe the trail
    // the live stream appended (sub-processes flicker). Read prev AFTER the fetch so events that
    // streamed in during the request are kept too.
    queryFn: async () =>
      mergeLiveEvents(qc.getQueryData<RunDetailData>(['run', id]), await durableClient.run(id)),
    // Live-follow an in-flight run; stop polling once it reaches a terminal state.
    refetchInterval: (q) => {
      const s = (q.state.data as RunDetailData | undefined)?.run.status;
      return s === 'running' || s === 'suspended' ? 1500 : false;
    },
  });
  // Worker health + the sibling run list feed the SAME `deriveRunState` the list uses, so the detail
  // header agrees with the list row (no-worker / queued / awaiting) instead of the old timeline-only
  // guess. Shared query caches (same keys as the list/Workers panel) — no extra network.
  const { data: health = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 5000,
  });
  const { data: siblingRuns = [] } = useQuery({
    queryKey: ['runs', '', ''],
    queryFn: () => durableClient.runs(),
    refetchInterval: 3000,
  });
  // Dead-letter link: a `dead` run may have been routed to a `dlq:<id>` handler workflow. Probe for
  // it (retry off so a 404 just hides the link) so we never render a dead link.
  const handlerId =
    (data as RunDetailData | undefined)?.run.status === 'dead' ? `dlq:${id}` : undefined;
  const { data: dlqHandler } = useQuery({
    queryKey: ['run', handlerId],
    queryFn: () => durableClient.run(handlerId as string),
    enabled: !!handlerId,
    retry: false,
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['run', id] });
    qc.invalidateQueries({ queryKey: ['runs'] });
  };
  // Live-tail over SSE: refresh the moment an event lands instead of waiting for the poll. Only
  // while the run is in flight; the 1.5s poll above stays as a fallback (e.g. transport with no
  // control plane, or a dropped stream).
  const liveStatus = (data as RunDetailData | undefined)?.run.status;
  const isLive = liveStatus === 'running' || liveStatus === 'suspended';
  useEffect(() => {
    if (!isLive) return;
    return durableClient.streamRun(id, (event) => {
      // `step.progress` carries a single live event from a still-running step — merge it straight
      // into the cached step's `events` so a long step's trail streams in line-by-line. Invalidating
      // per event would mean a store refetch per log line (hundreds for a fan-out step) AND would
      // show nothing until the step completes, since the store only gets `events` at completion.
      if (event.type === 'step.progress' && event.event && event.seq != null) {
        const seq = event.seq;
        const live = event.event;
        qc.setQueryData(['run', id], (prev: RunDetailData | undefined) => {
          if (!prev) return prev;
          return {
            ...prev,
            timeline: prev.timeline.map((step) =>
              step.seq === seq ? { ...step, events: [...(step.events ?? []), live] } : step,
            ),
          };
        });
        return;
      }
      // Lifecycle events (step started/completed, run settled) change authoritative state — refetch.
      qc.invalidateQueries({ queryKey: ['run', id] });
    });
  }, [id, isLive, qc]);
  const retry = useMutation({ mutationFn: () => durableClient.retry(id), onSuccess: invalidate });
  const cancel = useMutation({
    mutationFn: (compensate?: boolean) =>
      durableClient.cancel(id, compensate !== undefined ? { compensate } : {}),
    onSuccess: invalidate,
  });
  const cont = useMutation({ mutationFn: () => durableClient.continue(id), onSuccess: invalidate });
  // Manual recovery for a lost step dispatch (crashed worker / dropped job): re-dispatch every
  // remote step stuck `pending`. Reconcile-wake can't recover this on its own.
  const redispatch = useMutation({
    mutationFn: () => durableClient.redispatch(id),
    onSuccess: invalidate,
  });
  // Fix-and-replay: edit the input as JSON, then re-run as a fresh linked run.
  const fixReplay = useMutation({
    mutationFn: (input: unknown) => durableClient.retryWithInput(id, input),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      onOpenRun(r.runId);
    },
  });
  // Fix-and-replay editor state. This used to be `window.prompt` + `window.alert`: a single-line,
  // unstyled, un-resizable box for a multi-line JSON document, with the parse error arriving as a
  // second modal AFTER the edit was already discarded. The dialog keeps the draft on a parse error.
  const [fixOpen, setFixOpen] = useState(false);
  const [fixDraft, setFixDraft] = useState('');
  const [fixError, setFixError] = useState<string>();
  const onFixReplay = () => {
    setFixDraft(JSON.stringify((data as RunDetailData | undefined)?.run.input ?? {}, null, 2));
    setFixError(undefined);
    setFixOpen(true);
  };
  const submitFixReplay = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fixDraft);
    } catch (e) {
      setFixError(e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    setFixOpen(false);
    fixReplay.mutate(parsed);
  };
  // The selected step + the run it belongs to (a nested child step belongs to its child run, not the
  // root) — so the detail panel renders any lane's step, not just the root timeline's.
  const [selStep, setSelStep] = useState<{ step: StepCheckpoint; run: WorkflowRun }>();
  const [showRunIO, setShowRunIO] = useState(false);
  const [expandedChildren, setExpandedChildren] = useState<Set<string>>(new Set());
  // User-resizable height (px) of the spans panel; drag the divider above it. Clamped so neither the
  // graph nor the spans can be squeezed to nothing.
  const [spanHeight, setSpanHeight] = useState(240);
  function onResizeSpans(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      setSpanHeight((h) => Math.max(120, Math.min(720, h - ev.movementY)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function toggleChild(childId: string) {
    setExpandedChildren((prev) => {
      const next = new Set(prev);
      if (next.has(childId)) {
        next.delete(childId);
      } else {
        next.add(childId);
      }
      return next;
    });
  }

  if (!data) return <div className="p-8 text-sm text-zinc-600">Loading run…</div>;
  const { run, timeline } = data;
  // Saga compensations (seq < 0, one per undone step, in reverse) never mix into the body's
  // graph/spans/step-count — split them out once, up front, and feed `body` to everything below that
  // renders the normal flow. `compensations` gets its own section further down.
  const { body, compensations } = splitCompensations(timeline);
  const compSummary = compensationSummary(compensations);
  // A dead-letter run is a recovery path, not the normal flow — surface it as a banner. The two ends
  // of the relationship, linked both ways:
  //  - a `dlq:<id>` run is a handler → link back to the dead run it's handling
  //  - a `dead` run with an existing `dlq:<id>` handler → link forward to it
  const isDlqHandler = run.id.startsWith('dlq:');
  const dlqLink = isDlqHandler
    ? {
        id: run.id.slice(4),
        title: 'Dead-letter handler',
        subtitle: `started because run ${run.id.slice(4)} was dead-lettered`,
        cta: 'open dead run →',
      }
    : dlqHandler
      ? {
          id: `dlq:${run.id}`,
          title: 'Dead-lettered',
          subtitle: 'this run exceeded recovery and was routed to a DLQ handler',
          cta: 'open DLQ handler →',
        }
      : undefined;
  // Compensation banner copy, mutually exclusive: still unwinding takes priority over the settled
  // outcome; a settled unwind reads differently for a failure than a cancellation. A failed undo
  // (exhausted retries) appends a suffix to whichever of the three applies — the run's own error
  // stays displayed as the ORIGINAL failure regardless.
  const compBanner =
    compensations.length > 0
      ? (() => {
          const failedSuffix =
            compSummary.failed > 0
              ? ` ${compSummary.failed} undo${compSummary.failed === 1 ? '' : 's'} failed after retries — check ${compSummary.failed === 1 ? 'it' : 'them'} below.`
              : '';
          if (compSummary.pending > 0) {
            return {
              title: 'Compensating',
              subtitle: `undoing completed steps in reverse (${compSummary.done} of ${compSummary.total} done).${failedSuffix}`,
            };
          }
          if (run.status === 'cancelled') {
            return {
              title: 'Cancelled with compensation',
              subtitle: `completed steps were undone before cancelling.${failedSuffix}`,
            };
          }
          return {
            title: 'Saga compensated',
            subtitle: `the run failed and its ${compSummary.total} completed step${compSummary.total === 1 ? '' : 's'} were undone in reverse.${failedSuffix}`,
          };
        })()
      : undefined;
  const canRetry = run.status === 'failed' || run.status === 'suspended';
  const canCancel = run.status === 'running' || run.status === 'suspended';
  // A suspended/running run may have a step in flight — the only shape a lost dispatch can hang on.
  const canRedispatch = run.status === 'suspended' || run.status === 'running';
  // Paused at a breakpoint = a pending `signal` checkpoint named `breakpoint:*` (see ctx.breakpoint).
  const atBreakpoint = body.some(
    (s) => s.status === 'pending' && s.kind === 'signal' && s.name.startsWith('breakpoint'),
  );
  // Stable key identifying the selected step across lanes (root + nested children); compensation
  // steps share the same `runId#seq` shape (seq just happens to be negative), so this works for both.
  const selKey = selStep ? `${selStep.step.runId}#${selStep.step.seq}` : undefined;
  // Same deriver as the list row (with the timeline for step-level precision) → header + list AGREE.
  const detailState = deriveRunState(run, { runs: siblingRuns, health, timeline: body });
  // Show the tenant/partition only when it's a real named one (not the single-pool `default`).
  const tenant = run.namespace && run.namespace !== 'default' ? run.namespace : undefined;
  // The declaring package, or `undefined` for UNKNOWN — which the header states outright rather
  // than omitting, so "we don't know" never reads as "the app".
  const origin = knownOrigin(run.origin);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-line px-7 py-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight">{run.workflow}</h2>
            {parentRunIdOf(run.id) !== undefined && (
              <Button
                variant="alt"
                size="xs"
                onClick={() => onOpenRun(parentRunIdOf(run.id) as string)}
                className="mono uppercase tracking-wider"
                title={`Open the parent run (${parentRunIdOf(run.id)}) — the macro view this child belongs to`}
              >
                ↑ parent
              </Button>
            )}
            {retryOriginOf(run.id) !== undefined && (
              <Button
                variant="chip"
                size="xs"
                onClick={() => onOpenRun(retryOriginOf(run.id) as string)}
                className="mono uppercase tracking-wider text-zinc-300"
                title={`This is a retry-with-input of ${retryOriginOf(run.id)} — open the original run`}
              >
                ↩ original
              </Button>
            )}
            {isDlqHandler && (
              <Chip variant="danger" className="mono py-0.5 uppercase tracking-wider">
                dlq
              </Chip>
            )}
            <Badge status={detailState.status} />
            {detailState.detail && (
              <span className={`mono text-[11px] s-${detailState.status}`}>
                {detailState.detail}
              </span>
            )}
            {tenant && (
              <Chip
                variant="tenant"
                className="mono py-0.5"
                title="Tenant / worker-pool partition this run belongs to"
              >
                {tenant}
              </Chip>
            )}
            {/* WHICH LIBRARY declared this workflow — stated on every run, including the ones nobody
                could attribute. Unlike the list row (dense, scannable), the detail view has room to
                be explicit, and "unknown" is the honest answer here: not the host app, not blank. */}
            {origin ? (
              <Chip variant="origin" className="mono py-0.5" title={`Declared by ${origin}`}>
                {originLabel(origin)}
              </Chip>
            ) : (
              <Chip variant="origin-unknown" className="mono py-0.5" title={UNKNOWN_ORIGIN_TITLE}>
                origin {UNKNOWN_ORIGIN}
              </Chip>
            )}
            {compensations.length > 0 && (
              <Chip
                variant="warn"
                className={cn(
                  'mono py-0.5 uppercase tracking-wider',
                  compSummary.pending > 0 && 'pulse',
                )}
                title={
                  compSummary.pending > 0
                    ? `compensating: ${compSummary.done} of ${compSummary.total} undone`
                    : `${compSummary.total} step${compSummary.total === 1 ? '' : 's'} compensated`
                }
              >
                {compSummary.pending > 0 ? 'compensating' : 'compensated'}
              </Chip>
            )}
            <Chip className="mono bg-transparent py-0.5 text-zinc-500">v{run.workflowVersion}</Chip>
            <span className="mono tnum text-[11px] text-zinc-600">
              {body.length} {body.length === 1 ? 'step' : 'steps'}
            </span>
          </div>
          <div className="mono mt-1 truncate text-[11px] text-zinc-600">{run.id}</div>
          {run.tags && run.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {run.tags.map((t) => (
                <Chip key={t} className="mono">
                  #{t}
                </Chip>
              ))}
            </div>
          )}
          {run.searchAttributes && Object.keys(run.searchAttributes).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(run.searchAttributes).map(([k, v]) => (
                <Chip key={k} variant="attr" className="mono" title="search attribute">
                  {k}={String(v)}
                </Chip>
              ))}
            </div>
          )}
          {(data as RunDetailData | undefined)?.children?.length ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-zinc-600">children:</span>
              {(data as RunDetailData).children?.map((cid) => (
                <Button
                  key={cid}
                  variant="chip"
                  size="xs"
                  onClick={() => onOpenRun(cid)}
                  className="mono px-1.5 py-0"
                >
                  {cid}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            onClick={() => setShowRunIO(true)}
            className="mono px-2.5 normal-case tracking-normal text-zinc-400"
            title="Run input / output"
          >
            {'{ }'}
          </Button>
          {atBreakpoint && (
            <Button variant="warn" disabled={cont.isPending} onClick={() => cont.mutate()}>
              <PlayIcon width={12} height={12} />
              Continue
            </Button>
          )}
          <Button
            variant="brand"
            disabled={!canRetry || retry.isPending}
            onClick={() => retry.mutate()}
          >
            <RetryIcon width={12} height={12} />
            Retry
          </Button>
          {canRedispatch && (
            <Button
              variant="info"
              disabled={redispatch.isPending}
              onClick={() => redispatch.mutate()}
              title="Re-dispatch stuck `pending` remote steps — recovery for a lost step dispatch (crashed worker or dropped job)"
            >
              <BoltIcon width={12} height={12} />
              Re-dispatch
            </Button>
          )}
          {(run.status === 'dead' || run.status === 'failed') && (
            <Button
              variant="alt"
              disabled={fixReplay.isPending}
              onClick={onFixReplay}
              title="Edit the input and re-run as a fresh linked run"
            >
              <RetryIcon width={12} height={12} />
              Fix &amp; replay
            </Button>
          )}
          {canCancel && (
            <Button
              variant="warn"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(true)}
              title="Cancel and run saga compensations (undo completed steps in reverse)"
              className="bg-transparent"
            >
              <RetryIcon width={12} height={12} />
              Cancel + Undo
            </Button>
          )}
          <Button
            className="border-zinc-700"
            disabled={!canCancel || cancel.isPending}
            onClick={() => cancel.mutate(false)}
          >
            <XIcon width={12} height={12} />
            Cancel
          </Button>
        </div>
      </div>
      {dlqLink && (
        <div className="flex items-center gap-3 border-b border-rose-500/30 bg-rose-500/10 px-7 py-3">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-rose-500/40 bg-rose-500/15 text-sm text-rose-300"
            aria-hidden
          >
            ⚠
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-rose-200">{dlqLink.title}</div>
            <div className="mono truncate text-[11px] text-rose-300/70">{dlqLink.subtitle}</div>
          </div>
          <Button
            variant="danger"
            onClick={() => onOpenRun(dlqLink.id)}
            className="mono shrink-0 border-rose-500/40 bg-rose-500/15 px-2.5 text-[11px] normal-case tracking-normal text-rose-200 enabled:hover:bg-rose-500/25"
          >
            {dlqLink.cta}
          </Button>
        </div>
      )}
      {compBanner && (
        <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-7 py-3">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-amber-500/40 bg-amber-500/15 text-sm text-amber-300"
            aria-hidden
          >
            ↺
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-amber-200">{compBanner.title}</div>
            <div className="mono truncate text-[11px] text-amber-300/70">{compBanner.subtitle}</div>
          </div>
        </div>
      )}
      <div
        className="relative grid min-h-0 flex-1"
        style={{ gridTemplateRows: body.length > 0 ? `1fr ${spanHeight}px` : '1fr' }}
      >
        <div className="relative min-h-0">
          {body.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-zinc-600">
              No steps recorded yet.
            </div>
          ) : (
            <WorkflowGraph
              run={run}
              timeline={body}
              endStatus={detailState.status}
              selectedKey={selKey}
              onSelect={(step, stepRun) => setSelStep({ step, run: stepRun })}
              onOpenRun={onOpenRun}
              fmtDuration={durMs}
              expanded={expandedChildren}
              onToggleChild={toggleChild}
            />
          )}
          {(run.status === 'failed' || run.status === 'cancelled') && run.error && (
            <div className="mono absolute inset-x-6 bottom-6 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300 backdrop-blur">
              {run.error.message}
            </div>
          )}
        </div>
        {body.length > 0 && (
          // The spans height lives in the GRID TRACK above (`clamp(...)`), not here — an `auto` track
          // sizes to the tall span content's min-content and collapses the `1fr` WorkflowGraph row to
          // 0. With the track clamped, this wrapper just fills it and clips; SpansTimeline scrolls.
          <div className="relative min-h-0 overflow-hidden border-t border-line bg-black/20">
            {/* Drag the top edge to resize the spans panel. */}
            <div
              onPointerDown={onResizeSpans}
              className="absolute inset-x-0 top-0 z-10 h-1.5 -translate-y-1/2 cursor-row-resize hover:bg-brand/40"
              title="Drag to resize"
            />
            <SpansTimeline
              run={run}
              timeline={body}
              selectedKey={selKey}
              onSelect={(step, stepRun) => setSelStep({ step, run: stepRun })}
              onOpenRun={onOpenRun}
              expanded={expandedChildren}
              onToggleChild={toggleChild}
            />
          </div>
        )}
        {selStep && (
          <StepDetailPanel
            step={selStep.step}
            run={selStep.run}
            onClose={() => setSelStep(undefined)}
            onOpenRun={onOpenRun}
          />
        )}
        {showRunIO && <RunInfoPanel run={run} onClose={() => setShowRunIO(false)} />}
      </div>
      {compensations.length > 0 && (
        <CompensationSection
          compensations={compensations}
          selKey={selKey}
          onSelect={(step) => setSelStep({ step, run })}
        />
      )}
      <Dialog
        open={fixOpen}
        onOpenChange={setFixOpen}
        title="Fix & replay"
        subtitle={`re-runs ${run.id} as a fresh linked run`}
        footer={
          <>
            <Button onClick={() => setFixOpen(false)}>Cancel</Button>
            <Button variant="alt" disabled={fixReplay.isPending} onClick={submitFixReplay}>
              Replay
            </Button>
          </>
        }
      >
        <label
          className="mono mb-1.5 block text-[10px] uppercase tracking-[0.18em] text-zinc-500"
          htmlFor="fix-replay-input"
        >
          input
        </label>
        <textarea
          id="fix-replay-input"
          value={fixDraft}
          spellCheck={false}
          onChange={(e) => {
            setFixDraft(e.target.value);
            setFixError(undefined);
          }}
          className="mono h-64 w-full resize-y rounded-lg border border-line bg-black/40 p-3 text-[11.5px] leading-relaxed text-zinc-300 focus:border-zinc-600 focus:outline-none"
        />
        {fixError && (
          <p className="mono mt-2 rounded border border-bad/25 bg-bad/10 px-2 py-1 text-[11px] text-bad">
            {fixError}
          </p>
        )}
      </Dialog>
    </div>
  );
}

/** The open run id encoded in the URL hash (`#/run/<id>`) — so a run is deep-linkable / shareable. */
function runIdFromHash(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const match = window.location.hash.match(/^#\/run\/(.+)$/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : undefined;
}

export function App() {
  const [filter, setFilter] = useState<RunStatus | 'all'>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [attrFilter, setAttrFilter] = useState('');
  // Empty = EVERY tenant, and that default is deliberate: core keeps read paths namespace-unscoped,
  // so an operator who has always seen every tenant's runs keeps seeing them until they narrow.
  const [namespaceFilter, setNamespaceFilter] = useState('');
  // Origin is faceted in the browser (see OriginFacets) — it is the only filter here that must be
  // able to select ABSENCE, which an exact-match `RunQuery.origin` cannot express.
  const [originFilter, setOriginFilter] = useState<OriginFilter>(ALL_ORIGINS);
  // The open run lives in the URL hash so it survives reload and can be shared/linked.
  const [selected, setSelectedState] = useState<string | undefined>(() => runIdFromHash());
  const setSelected = useCallback((id?: string) => {
    setSelectedState(id);
    if (typeof window === 'undefined') return;
    const hash = id ? `#/run/${encodeURIComponent(id)}` : '';
    const url = hash || window.location.pathname + window.location.search;
    if (window.location.hash !== hash) window.history.pushState(null, '', url);
  }, []);
  // Follow back/forward and external hash edits.
  useEffect(() => {
    const sync = () => setSelectedState(runIdFromHash());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  const qc = useQueryClient();
  // Comma-separated `key:op:value` predicates (e.g. `amount:gte:200, tier:eq:pro`), ANDed server-side.
  const attrPredicates = attrFilter
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const {
    data: runsPages,
    isPending: runsPending,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    // Same key as before (tag/attr/namespace) — status/origin stay client-side filters over whatever
    // is loaded (see `originScoped`/`shown` below), so a new tag/attr/namespace is the only thing that
    // needs a fresh page 1; React Query drops the accumulated pages and starts over automatically the
    // moment this key changes.
    queryKey: ['runs', tagFilter, attrPredicates.join('|'), namespaceFilter],
    queryFn: ({ pageParam }) =>
      durableClient.runsPage(
        undefined,
        tagFilter || undefined,
        attrPredicates.length ? attrPredicates : undefined,
        // An empty box sends NO `namespace` param — all tenants, the historical default.
        { namespace: namespaceFilter || undefined },
        { limit: RUNS_PAGE_SIZE, offset: pageParam },
      ),
    initialPageParam: 0,
    // The server never returns a total match count (see `RunsPage`'s doc) — a full page is the only
    // signal that more might exist; a short page means the store is exhausted.
    getNextPageParam: (lastPage) => {
      const { limit, offset, count } = lastPage.page;
      return count === limit ? offset + limit : undefined;
    },
    // Keep the run list live. NOTE: on an infinite query this refetches EVERY already-loaded page (not
    // just the first) each interval, so cost grows with how far an operator has scrolled — acceptable
    // for this dashboard's scale, but worth revisiting if operators routinely scroll through thousands
    // of runs.
    refetchInterval: 3000,
  });
  const runs = useMemo(() => runsPages?.pages.flatMap((p) => p.runs) ?? [], [runsPages]);
  // Worker health, joined into each run row (no-worker) and the banner. Shares the `['workers']` cache
  // with the Workers panel (same queryKey → one fetch); polled a touch faster so "no worker" clears
  // promptly once a worker rejoins.
  const { data: health = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 5000,
  });
  const bulk = useMutation({
    mutationFn: (action: 'retry' | 'cancel') =>
      durableClient.bulk(action, {
        status: filter !== 'all' ? filter : undefined,
        tag: tagFilter || undefined,
        attr: attrPredicates.length ? attrPredicates : undefined,
        namespace: namespaceFilter || undefined,
        // Only a CONCRETE origin can be pushed to the server; `unknown` has no `RunQuery` spelling,
        // which is exactly why the bulk buttons are disabled while it is selected (below) — sending
        // no param there would quietly widen a destructive action to every origin.
        origin: originFilter.kind === 'origin' ? originFilter.origin : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
  });

  // The origin facet is applied FIRST, so the status counts and the list agree with the chip that is
  // lit. `runs` (unfaceted) still feeds the facet counts and the singleton lineage below.
  const originScoped = filterByOrigin(runs, originFilter);
  const counts = originScoped.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const shown = filter === 'all' ? originScoped : originScoped.filter((r) => r.status === filter);
  // Counted BEFORE the origin facet — the whole point is to be able to say "these N runs cannot be
  // matched by any package filter" at the moment a package filter shows nothing.
  const unattributed = unknownOriginCount(runs);
  const anyFilter =
    filter !== 'all' ||
    Boolean(tagFilter) ||
    Boolean(namespaceFilter) ||
    attrPredicates.length > 0 ||
    originFilter.kind !== 'all';
  // Why "retry all"/"cancel all" are off, or `undefined` when they're fine. The `unknown` facet is
  // the one filter the server cannot be told about, so a bulk action launched under it would act on
  // runs that are NOT on screen. Refusing loudly beats acting wider than the operator can see.
  const bulkBlocked =
    originFilter.kind === 'unknown'
      ? 'Bulk actions cannot be scoped to unclassified runs — runs with no origin have no server-side filter. Retry or cancel them from their own run view.'
      : undefined;
  // Workflows with runs waiting on a handler that has NO live worker — surfaced as a banner so it's
  // obvious nothing will progress until a worker rejoins (the "control plane up, no worker" case).
  const stalledWorkflows = [
    ...new Set(
      runs
        .filter((r) => deriveRunState(r, { runs, health }).status === 'no-worker')
        .map((r) => r.workflow),
    ),
  ];
  // Identity for the run list's `key` (see the `<RunsList key=…>` usage below) — every filter that
  // changes what `shown` contains, including the client-side-only status/origin ones.
  const runsListResetKey = `${filter}|${tagFilter}|${attrPredicates.join(',')}|${namespaceFilter}|${originFilterKey(originFilter)}`;

  return (
    <TooltipProvider>
      <div className="app-bg" />
      <div className="relative z-10 flex h-full flex-col">
        <Header counts={counts} filter={filter} onFilter={setFilter} />
        {stalledWorkflows.length > 0 && (
          <div className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200">
            <span className="s-no-worker inline-flex items-center gap-1.5">
              <span className="dot s-no-worker" aria-hidden />
            </span>
            <span>
              Runs waiting on handlers with no live worker:{' '}
              <span className="mono text-amber-100">{stalledWorkflows.join(', ')}</span>. Start a
              worker to unblock.
            </span>
          </div>
        )}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,360px)_1fr]">
          <aside className="flex min-h-0 flex-col border-r border-line">
            <div className="border-b border-line p-2">
              <InputField
                glyph="#"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                onClear={() => setTagFilter('')}
                clearLabel="clear tag filter"
                placeholder="filter by tag…"
                aria-label="filter by tag"
              />
              <InputField
                glyph="⛃"
                containerClassName="mt-1.5"
                value={attrFilter}
                onChange={(e) => setAttrFilter(e.target.value)}
                onClear={() => setAttrFilter('')}
                clearLabel="clear attribute filter"
                placeholder="attrs e.g. amount:gte:200, tier:eq:pro"
                aria-label="filter by search attribute"
                title="Typed search attributes: comma-separated key:op:value (ops eq ne gt gte lt lte)"
              />
              <InputField
                glyph="@"
                containerClassName="mt-1.5"
                value={namespaceFilter}
                onChange={(e) => setNamespaceFilter(e.target.value)}
                onClear={() => setNamespaceFilter('')}
                clearLabel="clear tenant filter"
                placeholder="filter by tenant / namespace…"
                aria-label="filter by tenant"
                title="Tenant / worker-pool partition (WorkflowRun.namespace). Empty shows every tenant."
              />
            </div>
            <OriginFacets runs={runs} value={originFilter} onChange={setOriginFilter} />
            {anyFilter && shown.length > 0 && (
              <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
                <span className="mono text-[10px] text-zinc-500">
                  {shown.length} {filter !== 'all' ? filter : ''} {tagFilter && `#${tagFilter}`}
                  {namespaceFilter && ` @${namespaceFilter}`}
                  {originFilter.kind === 'origin' && ` ⬡${originLabel(originFilter.origin)}`}
                  {originFilter.kind === 'unknown' && ` ⬡${UNKNOWN_ORIGIN}`}
                  {attrPredicates.length > 0 && ` ⛃${attrPredicates.length}`}
                </span>
                <Button
                  variant="brand"
                  size="xs"
                  disabled={bulk.isPending || bulkBlocked !== undefined}
                  title={bulkBlocked}
                  onClick={() => bulk.mutate('retry')}
                  className="mono ml-auto rounded"
                >
                  retry all
                </Button>
                <Button
                  variant="danger"
                  size="xs"
                  disabled={bulk.isPending || bulkBlocked !== undefined}
                  title={bulkBlocked}
                  onClick={() => bulk.mutate('cancel')}
                  className="mono rounded"
                >
                  cancel all
                </Button>
              </div>
            )}
            {/* No `overflow-auto` here — `RunsList`'s virtualized root owns its own scroll container
                (it needs a ref to the actual scrolling element), this just sizes the box it fills. */}
            <div className="min-h-0 flex-1">
              <RunsList
                // Remounts on any filter change: cheap for this list size, and it's the simplest way
                // to reset BOTH the virtualizer's scroll position and its row-height cache — a stale
                // scroll offset from the pre-filter list would otherwise leave the view scrolled deep
                // into a now much-shorter list.
                key={runsListResetKey}
                runs={shown}
                allRuns={runs}
                health={health}
                loading={runsPending}
                selected={selected}
                onSelect={setSelected}
                onSelectTag={setTagFilter}
                onSelectNamespace={setNamespaceFilter}
                onSelectOrigin={setOriginFilter}
                hasMore={hasNextPage}
                loadingMore={isFetchingNextPage}
                onLoadMore={fetchNextPage}
                emptyNotice={emptyRunsNotice({
                  anyFilter,
                  origin: originFilter,
                  unknownCount: unattributed,
                })}
              />
            </div>
          </aside>
          <main className="min-h-0">
            {selected ? (
              <RunDetail key={selected} id={selected} onOpenRun={setSelected} />
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div className="flex flex-col items-center">
                  <LogoMark className="h-10 w-10 text-zinc-800" />
                  <p className="mt-3 text-sm text-zinc-600">Select a run to see its timeline.</p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

import { useQuery } from '@tanstack/react-query';
import { DataTable } from '../../agora-kit/blocks/data-table';
import { EmptyState } from '../../agora-kit/blocks/empty-state';
import { ErrorBoundary, RegionError } from '../../agora-kit/blocks/error-boundary';
import { Hint } from '../../agora-kit/blocks/hint';
import {
  MetricCard,
  MetricGrid,
  MetricGridSkeleton,
  type MetricTone,
} from '../../agora-kit/blocks/metric-card';
import { PageHeader } from '../../agora-kit/blocks/page-header';
import { Panel } from '../../agora-kit/blocks/panel';
import { CheckIcon, ServerIcon } from '../../agora-kit/icons';
import { PageBody } from '../../agora-kit/shell/app-shell';
import { Badge } from '../../agora-kit/ui/badge';
import { Skeleton } from '../../agora-kit/ui/skeleton';
import { type CompatReport, durableClient, type GroupHealth } from '../../client/durable-client';
import { groupByPartition, type PartitionView } from '../../client/group-by-partition';
import { pivotByWorker, type WorkerView } from '../../client/pivot-by-worker';
import { type HealthSummary, summarizeHealth } from '../../client/summarize-health';
import { BlockedRunsList, CompatFleetTable, fleetOutcome } from '../CompatPanel';
import { relAgoMs, WorkerStatusCells } from './WorkerStatusCells';

/**
 * Workers (MONITOR): the fleet behind the console. Route-by-handler makes every `@Workflow`/`@Step`
 * its own queue and one worker serves many, so a per-queue list is noise — this page collapses it
 * onto the axes that vary: pods, partitions (tenant isolation), starved queues (work with no
 * consumer) and protocol compatibility.
 *
 * Container: owns the two polls (`/workers` every 10s, `/compat` every 15s without retry — an older
 * server without the endpoint must not be hammered). Everything below it is presentational.
 */
export function WorkersPage({ onOpenRun }: { onOpenRun: (id: string) => void }) {
  const workers = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 10_000,
  });
  const compat = useQuery({
    queryKey: ['compat'],
    queryFn: () => durableClient.compat(),
    refetchInterval: 15_000,
    retry: false,
  });
  return (
    <WorkersView
      groups={workers.data}
      groupsError={workers.data === undefined ? workers.error : null}
      onRetryGroups={() => void workers.refetch()}
      compat={compat.data}
      compatError={compat.data === undefined ? compat.error : null}
      onOpenRun={onOpenRun}
    />
  );
}

export function WorkersView({
  groups,
  groupsError,
  onRetryGroups,
  compat,
  compatError,
  onOpenRun,
}: {
  groups: GroupHealth[] | undefined;
  groupsError: unknown;
  onRetryGroups: () => void;
  compat: CompatReport | undefined;
  compatError: unknown;
  onOpenRun: (id: string) => void;
}) {
  const summary = groups ? summarizeHealth(groups) : undefined;
  return (
    <PageBody>
      <PageHeader
        title="Workers"
        description="Live heartbeats, partitions, starved queues and protocol compatibility."
      />
      <ErrorBoundary label="Fleet summary">
        {groupsError ? (
          <RegionError
            title="Workers could not be loaded"
            error={groupsError}
            onRetry={onRetryGroups}
          />
        ) : summary ? (
          <FleetMetrics summary={summary} compat={compat} />
        ) : (
          <MetricGridSkeleton />
        )}
      </ErrorBoundary>

      <ErrorBoundary label="Pods">
        <Panel
          title="Pods"
          description="each live worker, what it serves and its load"
          flush
          action={
            groups ? (
              <span className="mono tnum text-[11px] text-dim">
                {pivotByWorker(groups).length} live
              </span>
            ) : undefined
          }
        >
          <PodsTable workers={groups ? pivotByWorker(groups) : undefined} />
        </Panel>
      </ErrorBoundary>

      <div className="grid gap-5 lg:grid-cols-2">
        <ErrorBoundary label="Partitions">
          <Panel
            title="Partitions"
            description="tenant-isolation axis · default = control plane"
            flush
          >
            <PartitionsTable partitions={groups ? groupByPartition(groups) : undefined} />
          </Panel>
        </ErrorBoundary>
        <ErrorBoundary label="Starved queues">
          <Panel title="Starved queues" description="queued work with no worker consuming it" flush>
            <StarvedList summary={summary} />
          </Panel>
        </ErrorBoundary>
      </div>

      <ErrorBoundary label="Compatibility">
        <Panel
          title="Compatibility"
          description={
            compat
              ? `control plane ${compat.controlPlane.instanceId} · protocol v${compat.controlPlane.protocol}`
              : 'protocol and capability negotiation per pod'
          }
          flush
        >
          {compatError ? (
            <div className="p-4">
              <RegionError title="Compatibility report unavailable" error={compatError} />
            </div>
          ) : compat ? (
            <CompatFleetTable compat={compat} />
          ) : (
            <TableRowsSkeleton />
          )}
        </Panel>
      </ErrorBoundary>

      {compat && compat.blockedCount > 0 && (
        <ErrorBoundary label="Blocked runs">
          <Panel
            title="Blocked runs"
            description="parked: no compatible worker can take them"
            flush
            action={
              <Badge variant="destructive" className="mono tnum">
                {compat.blockedCount}
              </Badge>
            }
          >
            <BlockedRunsList blocked={compat.blocked} onOpenRun={onOpenRun} />
          </Panel>
        </ErrorBoundary>
      )}
    </PageBody>
  );
}

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

function FleetMetrics({
  summary,
  compat,
}: {
  summary: HealthSummary;
  compat: CompatReport | undefined;
}) {
  const outcome = compat ? fleetOutcome(compat) : undefined;
  const compatTone: MetricTone =
    outcome === 'incompatible' ? 'bad' : outcome === 'degraded' ? 'warn' : 'good';
  return (
    <MetricGrid>
      <MetricCard
        label="Live workers"
        value={summary.workerCount}
        tone="brand"
        caption={`${plural(summary.queueCount, 'queue')} served`}
      />
      <MetricCard
        label="Workflows"
        value={summary.workflowCount}
        tone="info"
        caption="@Workflow handlers"
      />
      <MetricCard label="Steps" value={summary.stepCount} tone="violet" caption="@Step handlers" />
      <MetricCard
        label="Starved"
        value={summary.starved.length}
        tone={summary.starved.length > 0 ? 'bad' : 'good'}
        caption={summary.allDraining ? 'all draining' : 'queues with no worker'}
      />
      <MetricCard
        label="Compatibility"
        value={compat ? (compat.incompatibleCount > 0 ? compat.incompatibleCount : '✓') : '—'}
        tone={compat ? compatTone : 'default'}
        caption={compat ? (outcome ?? '') : 'no report'}
      />
      <MetricCard
        label="Blocked runs"
        value={compat?.blockedCount ?? '—'}
        tone={(compat?.blockedCount ?? 0) > 0 ? 'bad' : 'default'}
        caption="no compatible worker"
      />
    </MetricGrid>
  );
}

function TableRowsSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4" aria-hidden>
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  );
}

export function PodsTable({ workers }: { workers: WorkerView[] | undefined }) {
  return (
    <DataTable
      label="Pods"
      rows={workers}
      loading={workers === undefined}
      rowKey={(w) => w.instanceId}
      empty={
        <EmptyState
          icon={<ServerIcon />}
          title="No live workers"
          description="No worker heartbeat in the last window. Start a worker, or check the transport can report health."
        />
      }
      columns={[
        {
          id: 'pod',
          header: 'Pod',
          cell: (w) => (
            <div className="flex min-w-0 flex-col">
              <span className="mono flex items-center gap-1.5 text-[12px] text-fg">
                <span className={`dot ${w.status ? 's-completed' : ''}`} aria-hidden />
                <span className="truncate">{w.instanceId}</span>
              </span>
              <span className="mono text-[10px] text-dim">
                {w.runtime ?? 'node'} · beat {relAgoMs(w.lastBeatAt)}
              </span>
            </div>
          ),
        },
        {
          id: 'partition',
          header: 'Partition',
          hideBelow: 'sm',
          cell: (w) => (
            <Badge
              variant={w.partition === 'default' ? 'neutral' : 'info'}
              className="mono text-[10px]"
            >
              {w.partition}
            </Badge>
          ),
        },
        {
          id: 'handlers',
          header: 'Handlers',
          cell: (w) => (
            <Hint label={w.handlers.join('\n')} align="start">
              <span className="mono tnum cursor-default text-[12px] text-fg-2 underline decoration-line-strong decoration-dotted underline-offset-4">
                {w.handlers.length}
              </span>
            </Hint>
          ),
        },
        {
          id: 'status',
          header: 'Load',
          hideBelow: 'md',
          className: 'whitespace-normal',
          cell: (w) => <WorkerStatusCells status={w.status} />,
        },
      ]}
    />
  );
}

function PartitionsTable({ partitions }: { partitions: PartitionView[] | undefined }) {
  return (
    <DataTable
      label="Partitions"
      rows={partitions}
      loading={partitions === undefined}
      rowKey={(p) => p.partition}
      empty={
        <EmptyState
          icon={<ServerIcon />}
          title="No partitions"
          description="Nothing is queued or served yet."
        />
      }
      columns={[
        {
          id: 'partition',
          header: 'Partition',
          cell: (p) => (
            <span className="mono flex items-center gap-1.5 text-[12px] text-fg">
              <span
                className={`dot ${p.starvedCount > 0 ? 's-failed' : p.workerCount > 0 ? 's-completed' : ''}`}
                aria-hidden
              />
              {p.partition}
            </span>
          ),
        },
        {
          id: 'workers',
          header: 'Workers',
          align: 'right',
          cell: (p) => <Num n={p.workerCount} />,
        },
        {
          id: 'handlers',
          header: 'Handlers',
          align: 'right',
          cell: (p) => <Num n={p.handlerCount} />,
        },
        { id: 'queued', header: 'Queued', align: 'right', cell: (p) => <Num n={p.totalDepth} /> },
        {
          id: 'starved',
          header: 'Starved',
          align: 'right',
          cell: (p) => <Num n={p.starvedCount} bad={p.starvedCount > 0} />,
        },
      ]}
    />
  );
}

function Num({ n, bad }: { n: number; bad?: boolean }) {
  return <span className={`mono tnum text-[12px] ${bad ? 'text-bad' : 'text-fg-2'}`}>{n}</span>;
}

function StarvedList({ summary }: { summary: HealthSummary | undefined }) {
  if (!summary) return <TableRowsSkeleton />;
  if (summary.starved.length === 0) {
    return (
      <EmptyState
        icon={<CheckIcon />}
        title="All queues draining"
        description={`${plural(summary.queueCount, 'queue')} across ${plural(summary.workerCount, 'worker')}, every backlog has a consumer.`}
      />
    );
  }
  return (
    <ul className="divide-y divide-line-soft">
      {summary.starved.map((g) => (
        <li key={g.group} className="flex items-center gap-3 px-4 py-3">
          <span className="dot s-failed" aria-hidden />
          <span className="mono min-w-0 flex-1 truncate text-[12px] text-fg">{g.group}</span>
          <Badge variant="destructive" className="mono tnum text-[10px]">
            {g.depth} queued · 0 workers
          </Badge>
        </li>
      ))}
    </ul>
  );
}

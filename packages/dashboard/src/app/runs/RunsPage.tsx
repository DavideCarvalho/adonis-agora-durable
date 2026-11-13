import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ActionDialog } from '../../agora-kit/blocks/action-dialog';
import { EmptyState } from '../../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../../agora-kit/blocks/error-boundary';
import { Toolbar } from '../../agora-kit/blocks/page-header';
import { ChevronLeftIcon, FilterIcon } from '../../agora-kit/icons';
import { cn } from '../../agora-kit/lib/utils';
import { Button } from '../../agora-kit/ui/button';
import {
  BULK_MATCH_CAP,
  deriveRunState,
  durableClient,
  type RunPredicates,
  type RunStatus,
  type TenantPicker,
} from '../../client/durable-client';
import {
  ALL_ORIGINS,
  emptyRunsNotice,
  filterByOrigin,
  type OriginFilter,
  originFilterKey,
  originLabel,
  UNKNOWN_ORIGIN,
  unknownOriginCount,
} from '../../client/run-origin';
import { AttributeFilters } from '../AttributeFilters';
import { XIcon } from '../icons';
import { OriginFacets } from '../OriginFacets';
import { LifecyclePendingFilter } from '../RunLifecycle';
import { LogoMark, RUNS_PAGE_SIZE, STATUSES, StatusDot } from '../run-status';
import { ValuePicker } from '../ValuePicker';
import { RunDetail } from './RunDetail';
import { RunsList } from './RunsList';

/** Every filter the runs board holds. Lives in the App (not the page) so leaving for Workers and
 *  coming back keeps the operator's narrowing. */
export interface RunFilters {
  status: RunStatus | 'all';
  setStatus: Dispatch<SetStateAction<RunStatus | 'all'>>;
  workflow: string[];
  setWorkflow: Dispatch<SetStateAction<string[]>>;
  tag: string[];
  setTag: Dispatch<SetStateAction<string[]>>;
  /** `key:op:value` predicates (e.g. `amount:gte:200`, `tier:in:pro|enterprise`), ANDed server-side. */
  attr: string[];
  setAttr: Dispatch<SetStateAction<string[]>>;
  /** Empty = EVERY namespace (core keeps read paths namespace-unscoped). */
  namespace: string[];
  setNamespace: Dispatch<SetStateAction<string[]>>;
  /** Faceted in the browser (OriginFacets) — the one filter that must select ABSENCE. */
  origin: OriginFilter;
  setOrigin: Dispatch<SetStateAction<OriginFilter>>;
}

export function useRunFilters(): RunFilters {
  const [status, setStatus] = useState<RunStatus | 'all'>('all');
  const [workflow, setWorkflow] = useState<string[]>([]);
  const [tag, setTag] = useState<string[]>([]);
  const [attr, setAttr] = useState<string[]>([]);
  const [namespace, setNamespace] = useState<string[]>([]);
  const [origin, setOrigin] = useState<OriginFilter>(ALL_ORIGINS);
  return {
    status,
    setStatus,
    workflow,
    setWorkflow,
    tag,
    setTag,
    attr,
    setAttr,
    namespace,
    setNamespace,
    origin,
    setOrigin,
  };
}

/**
 * The status chips, as the Runs page toolbar. Counts come from the SERVER
 * (`/runs/values?field=status`, scoped by every other active predicate) rather than a reduce over
 * the loaded pages: the chips drive a server-side status filter, so counting only what's been
 * scrolled into memory would zero the unselected chips and understate the selected one.
 */
export function StatusToolbar({
  scope,
  value,
  onChange,
}: {
  scope: RunPredicates;
  value: RunStatus | 'all';
  onChange: (next: RunStatus | 'all') => void;
}) {
  const { data: statusRows = [] } = useQuery({
    queryKey: ['run-values', 'status', scope],
    queryFn: () => durableClient.values('status', scope),
    refetchInterval: 5000,
  });
  const counts: Record<string, number> = {};
  for (const row of statusRows) {
    if (row.value !== null) counts[row.value] = row.count;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (key: RunStatus | 'all', n: number) => (
    <Button
      key={key}
      variant="chip"
      size="chip"
      aria-pressed={value === key}
      onClick={() => onChange(key)}
      className="shrink-0 rounded-md"
    >
      {key !== 'all' && <StatusDot status={key} />}
      <span className="uppercase tracking-wide">{key}</span>
      <span className="mono tnum text-faint">{n}</span>
    </Button>
  );
  return (
    <Toolbar
      label="filter runs by status"
      className="-mx-4 flex-nowrap overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
    >
      {chip('all', total)}
      {STATUSES.map((s) => chip(s, counts[s] ?? 0))}
    </Toolbar>
  );
}

/**
 * Runs (MONITOR): the board. Container — owns the paged `/runs` query, the bulk actions and the
 * worker-health join; renders the status toolbar, then the filter + list pane and the detail pane.
 * Below `lg` the panes stack: the list, or the open run with a way back.
 */
export function RunsPage({
  filters,
  selected,
  onSelect,
  onOpenRun,
  tenantPicker,
}: {
  filters: RunFilters;
  selected: string | undefined;
  onSelect: (id?: string) => void;
  onOpenRun: (id: string) => void;
  tenantPicker: TenantPicker | undefined;
}) {
  const {
    status: filter,
    setStatus: setFilter,
    workflow: workflowFilter,
    setWorkflow: setWorkflowFilter,
    tag: tagFilter,
    setTag: setTagFilter,
    attr: attrFilter,
    setAttr: setAttrFilter,
    namespace: namespaceFilter,
    setNamespace: setNamespaceFilter,
    origin: originFilter,
    setOrigin: setOriginFilter,
  } = filters;
  const qc = useQueryClient();
  const attrPredicates = attrFilter;
  const [filtersOpen, setFiltersOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1024,
  );
  const {
    data: runsPages,
    dataUpdatedAt: runsUpdatedAt,
    isPending: runsPending,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    // Status is a SERVER-SIDE predicate, same as workflow/tag/attr/namespace, so the list IS the
    // bulk filter's match set. Only origin stays client-side — it has no server-side spelling.
    queryKey: [
      'runs',
      filter,
      workflowFilter,
      tagFilter,
      attrPredicates.join('|'),
      namespaceFilter,
    ],
    queryFn: ({ pageParam }) =>
      durableClient.runsPage(
        filter !== 'all' ? filter : undefined,
        tagFilter.length ? tagFilter : undefined,
        attrPredicates.length ? attrPredicates : undefined,
        {
          namespace: namespaceFilter.length ? namespaceFilter : undefined,
          workflow: workflowFilter.length ? workflowFilter : undefined,
        },
        { page: pageParam, size: RUNS_PAGE_SIZE },
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const { currentPage, lastPage: last } = lastPage.meta;
      return currentPage < last ? currentPage + 1 : undefined;
    },
    // On an infinite query this refetches EVERY loaded page each interval — fine at this scale.
    refetchInterval: 3000,
  });
  const runs = useMemo(() => runsPages?.pages.flatMap((p) => p.data) ?? [], [runsPages]);
  const totalMatching = runsPages?.pages[0]?.meta.total;
  // The status chips are counted by their own query: refresh them with every list refresh.
  useEffect(() => {
    if (runsUpdatedAt > 0) void qc.invalidateQueries({ queryKey: ['run-values', 'status'] });
  }, [runsUpdatedAt, qc]);
  // Worker health, joined into each run row (no-worker) and the banner. Shares the `['workers']`
  // cache with the Workers page.
  const { data: health = [] } = useQuery({
    queryKey: ['workers'],
    queryFn: () => durableClient.workers(),
    refetchInterval: 5000,
  });
  // A bulk action reaches EVERY server-side match, not just the rows on screen — the dialog states
  // the action and the exact filter before anything runs.
  const [confirmBulk, setConfirmBulk] = useState<'retry' | 'cancel' | undefined>(undefined);
  const [bulkNotice, setBulkNotice] = useState<
    { action: 'retry' | 'cancel'; matched: number; applied: number } | undefined
  >(undefined);
  const bulk = useMutation({
    mutationFn: (action: 'retry' | 'cancel') =>
      durableClient.bulk(action, {
        status: filter !== 'all' ? filter : undefined,
        workflow: workflowFilter.length ? workflowFilter : undefined,
        tag: tagFilter.length ? tagFilter : undefined,
        attr: attrPredicates.length ? attrPredicates : undefined,
        namespace: namespaceFilter.length ? namespaceFilter : undefined,
        // Only a CONCRETE origin can be pushed to the server; `unknown` disables the bulk buttons.
        origin: originFilter.kind === 'origin' ? originFilter.origin : undefined,
      }),
    onSuccess: (result, action) => {
      setBulkNotice({ action, ...result });
      qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  // A capped result stays until dismissed; an uncapped one auto-dismisses like any toast.
  useEffect(() => {
    if (!bulkNotice || bulkNotice.matched >= BULK_MATCH_CAP) return;
    const timer = setTimeout(() => setBulkNotice(undefined), 6000);
    return () => clearTimeout(timer);
  }, [bulkNotice]);

  const shown = filterByOrigin(runs, originFilter);
  const unattributed = unknownOriginCount(runs);
  const anyFilter =
    filter !== 'all' ||
    workflowFilter.length > 0 ||
    tagFilter.length > 0 ||
    namespaceFilter.length > 0 ||
    attrPredicates.length > 0 ||
    originFilter.kind !== 'all';
  const activeFilterCount =
    workflowFilter.length +
    tagFilter.length +
    namespaceFilter.length +
    attrPredicates.length +
    (originFilter.kind !== 'all' ? 1 : 0);
  // Each picker's scope EXCLUDES its own axis (else a pick collapses the list to itself); origin
  // stays out of every scope (no `origin` column server-side).
  const status = filter !== 'all' ? filter : undefined;
  const workflowScope = useMemo(
    () => ({ status, tag: tagFilter, namespace: namespaceFilter, attr: attrFilter }),
    [status, tagFilter, namespaceFilter, attrFilter],
  );
  const tagScope = useMemo(
    () => ({ status, workflow: workflowFilter, namespace: namespaceFilter, attr: attrFilter }),
    [status, workflowFilter, namespaceFilter, attrFilter],
  );
  const namespaceScope = useMemo(
    () => ({ status, workflow: workflowFilter, tag: tagFilter, attr: attrFilter }),
    [status, workflowFilter, tagFilter, attrFilter],
  );
  const attrScope = useMemo(
    () => ({ status, workflow: workflowFilter, tag: tagFilter, namespace: namespaceFilter }),
    [status, workflowFilter, tagFilter, namespaceFilter],
  );
  const statusScope = useMemo(
    () => ({
      workflow: workflowFilter,
      tag: tagFilter,
      namespace: namespaceFilter,
      attr: attrFilter,
    }),
    [workflowFilter, tagFilter, namespaceFilter, attrFilter],
  );
  // A row's tag/namespace chip ADDS to the set, so comparing two is one click.
  const addTag = useCallback(
    (tag: string) => setTagFilter((prev) => (prev.includes(tag) ? prev : [...prev, tag])),
    [setTagFilter],
  );
  const addNamespace = useCallback(
    (ns: string) => setNamespaceFilter((prev) => (prev.includes(ns) ? prev : [...prev, ns])),
    [setNamespaceFilter],
  );
  // The `app` facet has no server-side spelling, so a bulk action under it would act on runs NOT on
  // screen. Refusing loudly beats acting wider than the operator can see.
  const bulkBlocked =
    originFilter.kind === 'unknown'
      ? "Bulk actions cannot be scoped to the app's own runs — runs with no package origin have no server-side filter. Retry or cancel them from their own run view."
      : undefined;
  const stalledWorkflows = useMemo(
    () => [
      ...new Set(
        runs
          .filter((r) => deriveRunState(r, { runs, health }).status === 'no-worker')
          .map((r) => r.workflow),
      ),
    ],
    [runs, health],
  );
  // Remount key for the list: every filter that changes what `shown` contains.
  const runsListResetKey = `${filter}|${workflowFilter.join('|')}|${tagFilter.join('|')}|${attrPredicates.join(',')}|${namespaceFilter.join('|')}|${originFilterKey(originFilter)}`;
  const bulkFilterSummary =
    [
      filter !== 'all' ? `status ${filter}` : undefined,
      workflowFilter.length > 0 ? `workflow ${workflowFilter.join(', ')}` : undefined,
      tagFilter.length > 0 ? `tag ${tagFilter.join(', ')}` : undefined,
      namespaceFilter.length > 0 ? `namespace ${namespaceFilter.join(', ')}` : undefined,
      attrPredicates.length > 0 ? `attr ${attrPredicates.join(' · ')}` : undefined,
      originFilter.kind === 'origin' ? `origin ${originLabel(originFilter.origin)}` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(' · ') || 'no filter — every run';

  return (
    <div className="flex h-full min-h-0 flex-col">
      {stalledWorkflows.length > 0 && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-[12px] text-warn md:px-6">
          <span className="dot s-no-worker shrink-0" aria-hidden />
          <span>
            Runs waiting on handlers with no live worker:{' '}
            <span className="mono font-medium">{stalledWorkflows.join(', ')}</span>. Start a worker
            to unblock.
          </span>
        </div>
      )}
      <div className="flex flex-col gap-3 px-4 pt-5 pb-3 md:px-6 md:pt-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold tracking-[0.01em] text-fg">Runs</h1>
            <p className="mt-1 text-xs text-faint">
              {totalMatching !== undefined
                ? `${totalMatching} ${anyFilter ? 'matching' : ''} run${totalMatching === 1 ? '' : 's'} · live`
                : 'Every workflow run, live.'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            aria-expanded={filtersOpen}
            aria-controls="runs-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <FilterIcon />
            Filters
            {activeFilterCount > 0 && (
              <span className="mono tnum rounded bg-primary/15 px-1 text-[10px] text-brand">
                {activeFilterCount}
              </span>
            )}
          </Button>
        </div>
        <StatusToolbar scope={statusScope} value={filter} onChange={setFilter} />
      </div>
      <div className="min-h-0 flex-1 px-0 pb-0 md:px-6 md:pb-6">
        <div className="grid h-full min-h-0 overflow-hidden border-t border-border bg-card agora-surface md:rounded-lg md:border lg:grid-cols-[minmax(300px,380px)_1fr]">
          <aside
            aria-label="Runs"
            className={cn(
              'flex min-h-0 flex-col border-border lg:border-r',
              selected !== undefined && 'hidden lg:flex',
            )}
          >
            <ErrorBoundary label="Filters">
              {filtersOpen && (
                <div id="runs-filters" className="border-b border-border p-2">
                  <ValuePicker
                    field="workflow"
                    scope={workflowScope}
                    glyph="ƒ"
                    label="filter by workflow"
                    placeholder="filter by workflow…"
                    value={workflowFilter}
                    onChange={setWorkflowFilter}
                    title="Workflow handler names (WorkflowRun.workflow). Several match ANY of them."
                  />
                  <div className="mt-1.5">
                    <ValuePicker
                      field="tag"
                      scope={tagScope}
                      glyph="#"
                      label="filter by tag"
                      placeholder="filter by tag…"
                      value={tagFilter}
                      onChange={setTagFilter}
                      title="Tags carried by a run (WorkflowRun.tags). Several match ANY of them."
                    />
                  </div>
                  <div className="mt-1.5 flex">
                    <LifecyclePendingFilter tags={tagFilter} onChange={setTagFilter} />
                  </div>
                  <div className="mt-1.5">
                    <ValuePicker
                      field="namespace"
                      scope={namespaceScope}
                      glyph="@"
                      label="filter by namespace"
                      placeholder="filter by namespace…"
                      value={namespaceFilter}
                      onChange={setNamespaceFilter}
                      title="Namespace: the worker pool a run belongs to (WorkflowRun.namespace). None selected shows every namespace."
                    />
                  </div>
                  <AttributeFilters value={attrFilter} onChange={setAttrFilter} scope={attrScope} />
                </div>
              )}
              <OriginFacets runs={runs} value={originFilter} onChange={setOriginFilter} />
            </ErrorBoundary>
            {anyFilter && shown.length > 0 && (
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="mono min-w-0 truncate text-[10px] text-dim">
                  {shown.length} {filter !== 'all' ? filter : ''}{' '}
                  {workflowFilter.length > 0 && `ƒ${workflowFilter.join(', ')}`}
                  {tagFilter.length > 0 && ` #${tagFilter.join(', ')}`}
                  {namespaceFilter.length > 0 && ` @${namespaceFilter.join(', ')}`}
                  {originFilter.kind === 'origin' && ` ⬡${originLabel(originFilter.origin)}`}
                  {originFilter.kind === 'unknown' && ` ⬡${UNKNOWN_ORIGIN}`}
                  {attrPredicates.length > 0 && ` ⛃${attrPredicates.length}`}
                </span>
                <Button
                  variant="brand"
                  size="micro"
                  disabled={bulk.isPending || bulkBlocked !== undefined}
                  title={bulkBlocked}
                  onClick={() => setConfirmBulk('retry')}
                  className="mono ml-auto"
                >
                  retry all
                </Button>
                <Button
                  variant="destructive"
                  size="micro"
                  disabled={bulk.isPending || bulkBlocked !== undefined}
                  title={bulkBlocked}
                  onClick={() => setConfirmBulk('cancel')}
                  className="mono"
                >
                  cancel all
                </Button>
              </div>
            )}
            {/* RunsList's virtualized root owns its scroll container; this only sizes the box. */}
            <div className="min-h-0 flex-1">
              <ErrorBoundary label="Run list" resetKeys={[runsListResetKey]}>
                <RunsList
                  key={runsListResetKey}
                  tenantPicker={tenantPicker}
                  runs={shown}
                  allRuns={runs}
                  health={health}
                  loading={runsPending}
                  selected={selected}
                  onSelect={onSelect}
                  onSelectTag={addTag}
                  onSelectNamespace={addNamespace}
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
              </ErrorBoundary>
            </div>
          </aside>
          <section
            aria-label="Run detail"
            className={cn('min-h-0 min-w-0', selected === undefined && 'hidden lg:block')}
          >
            {selected ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-border px-3 py-2 lg:hidden">
                  <Button variant="ghost" size="sm" onClick={() => onSelect(undefined)}>
                    <ChevronLeftIcon />
                    All runs
                  </Button>
                </div>
                <div className="min-h-0 flex-1">
                  <ErrorBoundary label="Run detail" resetKeys={[selected]}>
                    <RunDetail key={selected} id={selected} onOpenRun={onOpenRun} />
                  </ErrorBoundary>
                </div>
              </div>
            ) : (
              <EmptyState
                className="h-full"
                icon={<LogoMark className="size-6" />}
                title="No run selected"
                description="Select a run to see its timeline, steps and spans."
              />
            )}
          </section>
        </div>
      </div>
      <ActionDialog
        open={confirmBulk !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmBulk(undefined);
        }}
        title={confirmBulk === 'cancel' ? 'Cancel all matching runs' : 'Retry all matching runs'}
        description={bulkFilterSummary}
        footer={
          <>
            <Button size="sm" variant="outline" onClick={() => setConfirmBulk(undefined)}>
              Back
            </Button>
            <Button
              size="sm"
              variant={confirmBulk === 'cancel' ? 'destructive' : 'brand'}
              disabled={bulk.isPending}
              onClick={() => {
                if (confirmBulk) bulk.mutate(confirmBulk);
                setConfirmBulk(undefined);
              }}
            >
              {confirmBulk === 'cancel' ? 'cancel all' : 'retry all'}
            </Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-fg-2">
          This {confirmBulk === 'cancel' ? 'cancels' : 'retries'} <em>every</em> run matching the
          filter above on the server — including matches beyond the rows loaded on screen. The
          server acts on at most <span className="mono tnum text-fg">{BULK_MATCH_CAP}</span> matches
          per call.
        </p>
      </ActionDialog>
      {bulk.error && (
        <div
          role="alert"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-bad/40 bg-bad/15 px-4 py-2 text-[12px] text-bad"
        >
          Bulk action failed:{' '}
          {bulk.error instanceof Error ? bulk.error.message : String(bulk.error)}
        </div>
      )}
      {bulkNotice && (
        <output className="agora-rise fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-left shadow-2xl">
          <div className="min-w-0 flex-1 text-[12px]">
            <div className="text-fg">
              Bulk {bulkNotice.action}: <span className="mono tnum">{bulkNotice.applied}</span> of{' '}
              <span className="mono tnum">{bulkNotice.matched}</span> matched{' '}
              {bulkNotice.matched === 1 ? 'run' : 'runs'}{' '}
              {bulkNotice.action === 'cancel' ? 'cancelled' : 'retried'}.
            </div>
            {bulkNotice.matched >= BULK_MATCH_CAP && (
              <div className="mt-1 text-[11px] text-warn">
                Matched the {BULK_MATCH_CAP}-run server cap — only the first {BULK_MATCH_CAP} were
                affected. Run the action again to continue.
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="dismiss"
            onClick={() => setBulkNotice(undefined)}
          >
            <XIcon width={12} height={12} />
          </Button>
        </output>
      )}
    </div>
  );
}

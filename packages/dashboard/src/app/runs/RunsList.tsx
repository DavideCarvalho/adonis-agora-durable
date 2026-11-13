import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useRef } from 'react';
import { EmptyState } from '../../agora-kit/blocks/empty-state';
import { FlowIcon } from '../../agora-kit/icons';
import { cn } from '../../agora-kit/lib/utils';
import { badgeVariants, Badge as Chip } from '../../agora-kit/ui/badge';
import { Button } from '../../agora-kit/ui/button';
import { Skeleton } from '../../agora-kit/ui/skeleton';
import {
  deriveRunState,
  type GroupHealth,
  selectedTenant,
  type TenantPicker,
  type WorkflowRun,
} from '../../client/durable-client';
import {
  type emptyRunsNotice,
  knownOrigin,
  type OriginFilter,
  originLabel,
  UNKNOWN_ORIGIN_TITLE,
} from '../../client/run-origin';
import { relTime, StatusBadge } from '../run-status';
import { tenantLabel } from '../TenantPicker';

/** Placeholder rows shown while the first `/runs` fetch is in flight, so the pane never flashes
 *  "No runs yet." before real data lands. Same row footprint as a real run → no layout jump. */
export function RunsListSkeleton() {
  return (
    <ul className="divide-y divide-line-soft" aria-hidden>
      {['a', 'b', 'c', 'd', 'e', 'f'].map((k) => (
        <li key={k} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-2.5 w-48" />
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
  tenantPicker: picker,
}: {
  r: WorkflowRun;
  allRuns: WorkflowRun[];
  health: GroupHealth[];
  /** The organization picker (tenancy), to label the run's organization. */
  tenantPicker?: TenantPicker | undefined;
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
  // The organization column: shown while the viewer looks at several organizations at once.
  const showOrg = picker?.mode === 'pick' && selectedTenant() === undefined;
  return (
    <button
      type="button"
      onClick={() => onSelect(r.id)}
      className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors ${
        selected === r.id ? 'bg-hover' : 'hover:bg-hover/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-fg">{r.workflow}</span>
          {tenant && (
            <Chip
              variant="info"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-info/60 hover:text-info"
              title={`Namespace (worker pool) — click to show only ${tenant}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNamespace(tenant);
              }}
            >
              {tenant}
            </Chip>
          )}
          {showOrg && (
            <Chip
              variant="info"
              className="shrink-0 px-1 text-[9px]"
              title="Organization this run belongs to"
              data-run-org=""
            >
              {r.tenantId ? tenantLabel(picker, r.tenantId) : 'no organization'}
            </Chip>
          )}
          {/* Origin, when the run HAS one. An app-own run shows no chip here rather than
              a row of `app` noise — the facet above keeps its count on screen, the empty
              state names it, and the run's own detail header states it outright. */}
          {origin && (
            <Chip
              variant="teal"
              className="mono shrink-0 cursor-pointer px-1 text-[9px] hover:border-teal/60 hover:text-teal"
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
              variant="destructive"
              className="mono shrink-0 px-1 text-[9px] uppercase tracking-wider"
            >
              dlq
            </Chip>
          )}
        </span>
        <StatusBadge status={state.status} />
      </div>
      {/* WHY it's parked, in domain terms — the signal/webhook/child token, the singleton leader,
        or the handler that has no live worker. Only for the derived waiting states. */}
      {state.detail && (
        <div className={`mono truncate text-[11px] s-${state.status}`}>{state.detail}</div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="mono truncate text-[11px] text-faint">{r.id}</span>
        <span className="shrink-0 text-[11px] text-faint">{relTime(r.updatedAt)}</span>
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
                badgeVariants({ variant: 'neutral' }),
                'mono h-auto cursor-pointer py-0 text-[10px] hover:border-line-strong hover:text-fg',
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
  tenantPicker,
}: {
  /** The organization picker (tenancy): labels runs, and explains an empty list for a viewer with none. */
  tenantPicker?: TenantPicker | undefined;
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
   *  beyond what's been fetched (`meta.currentPage < meta.lastPage`). */
  hasMore?: boolean;
  /** True while a scroll-triggered `/runs?page=…` fetch is in flight. */
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
      <EmptyState
        className="p-6"
        icon={<FlowIcon />}
        title={tenantPicker?.mode === 'none' ? 'No organization picked' : 'No runs here'}
        description={
          <>
            <span className="block">
              {tenantPicker?.mode === 'none'
                ? 'Choose an organization to see its data.'
                : emptyNotice.message}
            </span>
            {emptyNotice.unclassified !== undefined && (
              <span className="mt-2 block text-[12px]">
                {emptyNotice.unclassified} run{emptyNotice.unclassified === 1 ? '' : 's'} here{' '}
                {emptyNotice.unclassified === 1 ? 'is' : 'are'} the app's own (no package origin),
                so no package filter can match {emptyNotice.unclassified === 1 ? 'it' : 'them'}.
              </span>
            )}
          </>
        }
        action={
          emptyNotice.unclassified !== undefined ? (
            <Button
              variant="chip"
              size="micro"
              className="mono"
              title={UNKNOWN_ORIGIN_TITLE}
              onClick={() => onSelectOrigin({ kind: 'unknown' })}
            >
              show app runs
            </Button>
          ) : undefined
        }
      />
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
                tenantPicker={tenantPicker}
              />
            </li>
          );
        })}
      </ul>
      {loadingMore && (
        <div className="mono px-4 py-2 text-center text-[11px] text-faint">loading more…</div>
      )}
    </div>
  );
}

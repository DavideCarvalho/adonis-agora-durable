import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  durableClient,
  type RunPredicates,
  type RunValueField,
  type RunValueRow,
} from '../client/durable-client';
import { MultiSelect, type MultiSelectOption } from './ui/multi-select';

/** Values per request. Two screenfuls, so the first page fills the list and the second is fetched
 *  before an operator reaches the bottom of it. */
const PAGE_SIZE = 50;

/** How long typing settles before it becomes a request. Long enough that a word costs one query,
 *  short enough that the list feels attached to the keyboard. */
const SEARCH_DEBOUNCE_MS = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * A value's options, from the server. `null` is dropped: it is a real bucket for counting (a run
 * with no origin) but not something an operator can select as text — the origin facet has its own
 * "unknown" chip for exactly that.
 */
function selectable(rows: RunValueRow[]): MultiSelectOption[] {
  return rows
    .filter((row): row is { value: string; count: number } => row.value !== null)
    .map((row) => ({ value: row.value, count: row.count }));
}

export interface ValuePickerProps {
  /** The axis to enumerate — `tag`, `namespace`, `attr`, `attr.<key>`, … */
  field: RunValueField;
  /**
   * The rest of the active filter. Excludes this picker's OWN axis: including it would collapse the
   * list to whatever is already selected the moment an operator picks a value, leaving a control
   * that can only ever be narrowed once.
   */
  scope: RunPredicates;
  value: string[];
  onChange: (next: string[]) => void;
  glyph?: React.ReactNode;
  label: string;
  placeholder: string;
  title?: string;
  /** Single-select behaviour for a control that names ONE thing (the attribute key). */
  single?: boolean;
}

/**
 * The console's filter control: what the runs actually contain, searched and paged on the SERVER.
 *
 * Both of those are load-bearing rather than polish. The list is bounded — tag cardinality grows
 * with the data, so the values an operator wants are routinely outside the first page — which makes
 * a search that only filters the fetched page unable to find precisely the values it was cut from.
 * And a bound with no way past it is a ceiling; paging is what turns it into a window.
 */
export function ValuePicker({
  field,
  scope,
  value,
  onChange,
  glyph,
  label,
  placeholder,
  title,
  single,
}: ValuePickerProps) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);

  const query = useInfiniteQuery({
    queryKey: ['run-values', field, scope, debouncedSearch],
    queryFn: ({ pageParam }) =>
      durableClient.values(field, scope, {
        limit: PAGE_SIZE,
        offset: pageParam,
        search: debouncedSearch,
      }),
    initialPageParam: 0,
    // A short page is the last one. Counting what is already loaded (rather than multiplying the
    // page number) keeps the offset right even if a page comes back trimmed.
    getNextPageParam: (last: RunValueRow[], all: RunValueRow[][]) =>
      last.length < PAGE_SIZE ? undefined : all.reduce((n, page) => n + page.length, 0),
    staleTime: 10_000,
  });

  const options = useMemo(() => selectable(query.data?.pages.flat() ?? []), [query.data]);

  return (
    <MultiSelect
      label={label}
      placeholder={placeholder}
      {...(title !== undefined && { title })}
      {...(glyph !== undefined && { glyph })}
      value={value}
      onChange={(next) => onChange(single ? next.slice(-1) : next)}
      options={options}
      search={search}
      onSearchChange={setSearch}
      loading={query.isLoading}
      failed={query.isError}
      hasMore={query.hasNextPage}
      loadingMore={query.isFetchingNextPage}
      onLoadMore={() => void query.fetchNextPage()}
    />
  );
}

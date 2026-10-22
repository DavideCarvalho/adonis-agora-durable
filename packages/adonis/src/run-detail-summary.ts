import { childIdsOf, FOLDED_PREFIX, type FoldedChildren, parseFanGroup } from './fan-join.js';
import {
  type CheckpointQuery,
  type CheckpointStat,
  checkpointNameKind,
  type StateStore,
  type StepCheckpoint,
  type WorkflowRun,
} from './interfaces.js';

/**
 * A parallel fan (a `ctx.all`, a step fan, a polyglot `gather`) reduced to what a detail view needs
 * to draw it: one node, its progress and its failures. A run detail with a 40,000-item fan otherwise
 * carries every member — megabytes of JSON, and one rendered row (or fetched child) per member.
 */
export interface FanSummary {
  /** The fan's `parallelGroup`. */
  group: string;
  /** The members' common step name, or `child runs` for a fan of child workflows. */
  label: string;
  firstSeq: number;
  lastSeq: number;
  /** Members started so far: steps, or child runs (a folded checkpoint counts as the children it stands for). */
  size: number;
  /**
   * The fan's declared size, when its group carries it. More than `size` while waves are still to
   * be sent (`concurrency`), and for good when a failFast fan stopped early.
   */
  total?: number | undefined;
  /** `total - size`: members never started yet — or never to start, once the run has finished. */
  notStarted?: number | undefined;
  /** The fan stops at its first failure. */
  failFast: boolean;
  /** Members by status. A child that failed counts as `failed`, though its checkpoint is `completed`. */
  counts: Partial<Record<StepCheckpoint['status'], number>>;
  startedAt?: Date | undefined;
  finishedAt?: Date | undefined;
  /** The first {@link FAN_SUMMARY_FAILURES} failed members, so a failure shows without paging. */
  failures: StepCheckpoint[];
}

/** A page of one fan's members, in seq order. */
export interface FanPage {
  items: StepCheckpoint[];
  /** Members matching the query, across all pages. */
  total: number;
  /** A validator for this page, when the source can compute one without reading the members. */
  etag?: string | undefined;
  /**
   * Set when the query's `ifNoneMatch` matched {@link etag}: the page has not changed, so nothing
   * was read. `items` is empty and `total` is 0 as placeholders, not the fan's; keep the page the
   * caller already holds.
   */
  notModified?: true | undefined;
}

export interface FanPageQuery {
  offset?: number | undefined;
  limit?: number | undefined;
  /** Only failed members (a failed step, or a child that failed). */
  failedOnly?: boolean | undefined;
  /** An HTTP `If-None-Match` value: a page whose `etag` it names comes back `notModified`. */
  ifNoneMatch?: string | undefined;
}

export const FAN_SUMMARY_FAILURES = 20;
/** The most children a summarized detail lists by id; `childCount` carries the rest. */
export const SUMMARY_CHILD_LIMIT = 200;
const FAN_PAGE_MAX = 500;

/** How many children a folded `fan:` checkpoint stands for; undefined for any other checkpoint. */
export function foldedCount(cp: StepCheckpoint): number | undefined {
  if (!cp.name.startsWith(FOLDED_PREFIX)) return undefined;
  const values = (cp.output as Partial<FoldedChildren> | null | undefined)?.values;
  return Array.isArray(values) ? values.length : 0;
}

/** A failed member: a failed step, or a child whose completion reports `ok: false`. */
export function isFailedMember(cp: StepCheckpoint): boolean {
  if (cp.status === 'failed') return true;
  if (!cp.name.startsWith('signal:child:') || cp.status !== 'completed') return false;
  return (cp.output as { ok?: unknown } | null | undefined)?.ok === false;
}

function fanLabel(members: StepCheckpoint[]): string {
  if (members.some((cp) => cp.name.startsWith('signal:child:') || foldedCount(cp) !== undefined)) {
    return 'child runs';
  }
  const first = members[0]?.name ?? '';
  return members.every((cp) => cp.name === first) ? first : 'steps';
}

/** Summarize one fan's members (in seq order). */
export function summarizeFan(group: string, members: StepCheckpoint[]): FanSummary {
  const counts: FanSummary['counts'] = {};
  const failures: StepCheckpoint[] = [];
  let size = 0;
  let startedAt: Date | undefined;
  let finishedAt: Date | undefined;
  let firstSeq = Number.POSITIVE_INFINITY;
  let lastSeq = Number.NEGATIVE_INFINITY;
  for (const cp of members) {
    firstSeq = Math.min(firstSeq, cp.seq);
    lastSeq = Math.max(lastSeq, cp.seq);
    const folded = foldedCount(cp);
    const n = folded ?? 1;
    size += n;
    const status = isFailedMember(cp) ? 'failed' : cp.status;
    counts[status] = (counts[status] ?? 0) + n;
    if (status === 'failed' && failures.length < FAN_SUMMARY_FAILURES) failures.push(cp);
    if (cp.status !== 'pending' && cp.status !== 'running') {
      if (!startedAt || cp.startedAt < startedAt) startedAt = cp.startedAt;
      if (!finishedAt || cp.finishedAt > finishedAt) finishedAt = cp.finishedAt;
    } else if (!startedAt || cp.enqueuedAt < startedAt) {
      startedAt = cp.enqueuedAt;
    }
  }
  const parsed = parseFanGroup(group);
  const total = parsed?.size;
  return {
    group,
    label: fanLabel(members),
    firstSeq,
    lastSeq,
    size,
    total,
    notStarted: total === undefined ? undefined : Math.max(0, total - size),
    failFast: parsed?.failFast ?? false,
    counts,
    startedAt,
    finishedAt,
    failures,
  };
}

/**
 * Split a run's timeline into the checkpoints a detail view lists one by one and the fans it draws as
 * one node each: every `parallelGroup` with more than `over` members, or declared wider than that,
 * becomes a {@link FanSummary}, and its members leave the timeline. Smaller groups and ungrouped
 * steps stay as they are.
 */
export function summarizeTimeline(
  timeline: StepCheckpoint[],
  over: number,
): { timeline: StepCheckpoint[]; fans: FanSummary[] } {
  const byGroup = new Map<string, StepCheckpoint[]>();
  for (const cp of timeline) {
    if (cp.parallelGroup === undefined) continue;
    const members = byGroup.get(cp.parallelGroup);
    if (members) members.push(cp);
    else byGroup.set(cp.parallelGroup, [cp]);
  }
  const summarized = new Set<string>();
  const fans: FanSummary[] = [];
  for (const [group, members] of byGroup) {
    // A fan sent in small waves has few rows yet; its declared size is what makes it wide.
    if (members.length <= over && (parseFanGroup(group)?.size ?? 0) <= over) continue;
    summarized.add(group);
    fans.push(summarizeFan(group, members));
  }
  if (fans.length === 0) return { timeline, fans };
  return {
    timeline: timeline.filter(
      (cp) => cp.parallelGroup === undefined || !summarized.has(cp.parallelGroup),
    ),
    fans: fans.sort((a, b) => a.firstSeq - b.firstSeq),
  };
}

/** One page of a fan's members out of a run's timeline. */
export function pageFan(timeline: StepCheckpoint[], group: string, query: FanPageQuery): FanPage {
  const matching = timeline.filter(
    (cp) => cp.parallelGroup === group && (!query.failedOnly || isFailedMember(cp)),
  );
  const { offset, limit } = fanPageBounds(query);
  return { items: matching.slice(offset, offset + limit), total: matching.length };
}

/** A {@link FanPageQuery}'s offset and limit, clamped to sane bounds. */
export function fanPageBounds(query: FanPageQuery): { offset: number; limit: number } {
  const offset =
    query.offset !== undefined && Number.isFinite(query.offset)
      ? Math.max(0, Math.floor(query.offset))
      : 0;
  const limit =
    query.limit !== undefined && Number.isFinite(query.limit)
      ? Math.min(FAN_PAGE_MAX, Math.max(1, Math.floor(query.limit)))
      : 100;
  return { offset, limit };
}

/**
 * A run's detail: the run, its step timeline, and the runs it spawned. With
 * {@link RunDetailOptions.summarizeFansOver}, the members of a wide fan are left out of `timeline`
 * and drawn from {@link fans} instead, and `children` lists only the first {@link SUMMARY_CHILD_LIMIT}.
 */
export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order, less the members of a summarized fan. */
  timeline: StepCheckpoint[];
  /** Ids of runs this run spawned. Capped when summarized — see {@link childCount}. */
  children: string[];
  /** The fans drawn as one node each, when the detail was asked to summarize them. */
  fans?: FanSummary[] | undefined;
  /** How many children the run has, when `children` lists only the first of them. */
  childCount?: number | undefined;
  /**
   * A validator for this detail, when the source can compute one without reading the timeline (a
   * store with `checkpointStats`): it changes whenever the run or any of its checkpoints does.
   */
  etag?: string | undefined;
  /**
   * Set when {@link RunDetailOptions.ifNoneMatch} matched {@link etag}: nothing changed, so only
   * `run` was read — `timeline` and `children` are empty, not the run's.
   */
  notModified?: true | undefined;
}

/** How to shape a {@link RunDetail}. */
export interface RunDetailOptions {
  /**
   * Summarize every fan with more than this many members into a {@link FanSummary} instead of
   * listing them, and cap `children`. Unset returns the full timeline. A view of a run with a wide
   * fan should set it: the full detail of a 40k-member fan is megabytes.
   */
  summarizeFansOver?: number | undefined;
  /**
   * An HTTP `If-None-Match` value. When it names the detail's current {@link RunDetail.etag}, the
   * detail comes back `notModified` without the timeline being read. Ignored when no etag can be
   * computed (no `summarizeFansOver`, or a store without the checkpoint aggregates).
   */
  ifNoneMatch?: string | undefined;
}

/**
 * The reads a {@link RunDetail} is built from — an engine, a dashboard port, or a gateway. With both
 * of the optional aggregate reads (a store's `checkpointStats` + `queryCheckpoints`), a summarized
 * detail and a fan page are built from the aggregates instead of the whole checkpoint list, and come
 * back with an `etag`.
 */
export interface RunDetailSource {
  getRun(runId: string): Promise<WorkflowRun | null>;
  listCheckpoints(runId: string): Promise<StepCheckpoint[]>;
  getRunChildren(runId: string): Promise<string[]>;
  checkpointStats?: StateStore['checkpointStats'] | undefined;
  queryCheckpoints?: StateStore['queryCheckpoints'] | undefined;
}

/** Read `runId`'s {@link RunDetail}, summarized per `options`, or null for an unknown run. */
export async function loadRunDetail(
  source: RunDetailSource,
  runId: string,
  options?: RunDetailOptions,
): Promise<RunDetail | null> {
  const run = await source.getRun(runId);
  if (!run) return null;
  const over = options?.summarizeFansOver;
  if (over === undefined) {
    const [timeline, children] = await Promise.all([
      source.listCheckpoints(runId),
      source.getRunChildren(runId),
    ]);
    return { run, timeline, children };
  }
  if (aggregatesCheckpoints(source)) {
    // The buckets are read before any row, so a write landing mid-read leaves the ETag older than
    // the body: the next poll misses and re-reads, rather than pinning a stale body.
    const stats = await source.checkpointStats(runId);
    const etag = runDetailEtag(run, stats, over);
    if (etagMatches(options?.ifNoneMatch, etag)) {
      return { run, timeline: [], children: [], notModified: true, etag };
    }
    return { run, ...(await summarizeRunFromStore(source, runId, over, stats)), etag };
  }
  // Summarized: the children come from the timeline already loaded, rather than a second read of
  // every child-edge checkpoint (one per child of a wide fan). A child whose waiter is written but
  // whose placeholder checkpoint is not yet is missing for that one read; the next one lists it.
  const full = await source.listCheckpoints(runId);
  const { timeline, fans } = summarizeTimeline(full, over);
  const ids = [...new Set(childIdsOf(full))];
  return {
    run,
    timeline,
    children: ids.slice(0, SUMMARY_CHILD_LIMIT),
    fans,
    childCount: ids.length,
  };
}

/** One page of `runId`'s fan `group`, or null for an unknown run. */
export async function loadFanMembers(
  source: Pick<
    RunDetailSource,
    'getRun' | 'listCheckpoints' | 'checkpointStats' | 'queryCheckpoints'
  >,
  runId: string,
  group: string,
  query: FanPageQuery,
): Promise<FanPage | null> {
  if (!(await source.getRun(runId))) return null;
  if (aggregatesCheckpoints(source)) {
    const stats = await source.checkpointStats(runId, { group });
    const etag = fanPageEtag(group, stats, query);
    if (etagMatches(query.ifNoneMatch, etag)) {
      return { items: [], total: 0, notModified: true, etag };
    }
    return { ...(await pageFanFromStore(source, runId, group, query, stats)), etag };
  }
  return pageFan(await source.listCheckpoints(runId), group, query);
}

// --- store-side aggregates (StateStore.checkpointStats / queryCheckpoints) ----------------------

/** Checkpoint names that record a parent→child edge: an awaited child, a folded group of them, a spawn. */
const CHILD_EDGE_PREFIXES = ['signal:child:', FOLDED_PREFIX, 'spawn:'];

/** A source that aggregates checkpoints itself: both halves of the pair are present. */
export type CheckpointAggregatingStore = Required<
  Pick<StateStore, 'checkpointStats' | 'queryCheckpoints'>
>;

/** Whether `source` has both aggregate reads ({@link StateStore.checkpointStats} + `queryCheckpoints`). */
export function aggregatesCheckpoints<
  T extends {
    checkpointStats?: StateStore['checkpointStats'] | undefined;
    queryCheckpoints?: StateStore['queryCheckpoints'] | undefined;
  },
>(source: T): source is T & CheckpointAggregatingStore {
  return source.checkpointStats !== undefined && source.queryCheckpoints !== undefined;
}

/**
 * {@link StateStore.checkpointStats} over checkpoints already in memory — the reference a store's
 * `GROUP BY` must agree with, and the in-memory store's implementation.
 */
export function checkpointStatsOf(
  checkpoints: StepCheckpoint[],
  opts?: { group?: string | undefined },
): CheckpointStat[] {
  const buckets = new Map<string, CheckpointStat>();
  for (const cp of checkpoints) {
    const group = cp.parallelGroup ?? null;
    if (opts?.group !== undefined && group !== opts.group) continue;
    const nameKind = checkpointNameKind(cp.name);
    const key = JSON.stringify([group, cp.status, nameKind]);
    const enqueuedAt = cp.enqueuedAt ?? cp.startedAt;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, {
        group,
        status: cp.status,
        nameKind,
        count: 1,
        minSeq: cp.seq,
        maxSeq: cp.seq,
        minName: cp.name,
        maxName: cp.name,
        minEnqueuedAt: enqueuedAt,
        minStartedAt: cp.startedAt,
        maxStartedAt: cp.startedAt,
        maxFinishedAt: cp.finishedAt,
        sumAttempts: cp.attempts,
      });
      continue;
    }
    bucket.count += 1;
    bucket.minSeq = Math.min(bucket.minSeq, cp.seq);
    bucket.maxSeq = Math.max(bucket.maxSeq, cp.seq);
    if (cp.name < bucket.minName) bucket.minName = cp.name;
    if (cp.name > bucket.maxName) bucket.maxName = cp.name;
    if (enqueuedAt < bucket.minEnqueuedAt) bucket.minEnqueuedAt = enqueuedAt;
    if (cp.startedAt < bucket.minStartedAt) bucket.minStartedAt = cp.startedAt;
    if (cp.startedAt > bucket.maxStartedAt) bucket.maxStartedAt = cp.startedAt;
    if (cp.finishedAt > bucket.maxFinishedAt) bucket.maxFinishedAt = cp.finishedAt;
    bucket.sumAttempts += cp.attempts;
  }
  return [...buckets.values()];
}

/** {@link StateStore.queryCheckpoints} over checkpoints already in memory, sorted by `seq` here. */
export function queryCheckpointsOf(
  checkpoints: StepCheckpoint[],
  query: CheckpointQuery,
): StepCheckpoint[] {
  const excluded = new Set(query.excludeGroups ?? []);
  const matching = checkpoints
    .filter(
      (cp) =>
        (query.group === undefined || cp.parallelGroup === query.group) &&
        (cp.parallelGroup === undefined || !excluded.has(cp.parallelGroup)) &&
        (query.statuses === undefined || query.statuses.includes(cp.status)) &&
        (query.namePrefixes === undefined ||
          query.namePrefixes.some((prefix) => cp.name.startsWith(prefix))),
    )
    .sort((a, b) => a.seq - b.seq);
  const offset = query.offset ?? 0;
  return matching.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
}

const TERMINAL = (status: StepCheckpoint['status']) => status !== 'pending' && status !== 'running';

/** True when a group with `rows` checkpoints is summarized: the rule of `summarizeTimeline`. */
function isWide(group: string, rows: number, over: number): boolean {
  return rows > over || (parseFanGroup(group)?.size ?? 0) > over;
}

/** Merge two seq-sorted lists of distinct checkpoints into one, in seq order. */
function mergeBySeq(a: StepCheckpoint[], b: StepCheckpoint[]): StepCheckpoint[] {
  return [...a, ...b].sort((x, y) => x.seq - y.seq);
}

/**
 * A child of a fan whose `signal:child:` checkpoint is `completed` failed when its completion says
 * `ok: false` — a payload the store cannot read (a codec may encode it), so those rows are loaded
 * and judged here. Only the completed child rows of the one group are read.
 */
async function failedChildren(
  store: CheckpointAggregatingStore,
  runId: string,
  group: string,
  buckets: CheckpointStat[],
): Promise<{ completed: StepCheckpoint[]; failed: StepCheckpoint[] }> {
  if (!buckets.some((b) => b.nameKind === 'child' && b.status === 'completed')) {
    return { completed: [], failed: [] };
  }
  const completed = await store.queryCheckpoints(runId, {
    group,
    statuses: ['completed'],
    namePrefixes: ['signal:child:'],
  });
  return { completed, failed: completed.filter(isFailedMember) };
}

async function summarizeFanFromStats(
  store: CheckpointAggregatingStore,
  runId: string,
  group: string,
  buckets: CheckpointStat[],
  folded: StepCheckpoint[],
): Promise<FanSummary> {
  const counts: FanSummary['counts'] = {};
  const add = (status: StepCheckpoint['status'], n: number) => {
    counts[status] = (counts[status] ?? 0) + n;
  };
  let size = 0;
  let startedAt: Date | undefined;
  let finishedAt: Date | undefined;
  let firstSeq = Number.POSITIVE_INFINITY;
  let lastSeq = Number.NEGATIVE_INFINITY;
  let minName: string | undefined;
  let maxName: string | undefined;
  let childRuns = false;
  for (const b of buckets) {
    firstSeq = Math.min(firstSeq, b.minSeq);
    lastSeq = Math.max(lastSeq, b.maxSeq);
    if (minName === undefined || b.minName < minName) minName = b.minName;
    if (maxName === undefined || b.maxName > maxName) maxName = b.maxName;
    if (b.nameKind === 'child' || b.nameKind === 'folded') childRuns = true;
    if (TERMINAL(b.status)) {
      if (!startedAt || b.minStartedAt < startedAt) startedAt = b.minStartedAt;
      if (!finishedAt || b.maxFinishedAt > finishedAt) finishedAt = b.maxFinishedAt;
    } else if (!startedAt || b.minEnqueuedAt < startedAt) {
      startedAt = b.minEnqueuedAt;
    }
    // Folded rows and completed child rows count by their payload, below.
    if (b.nameKind === 'folded') continue;
    if (b.nameKind === 'child' && b.status === 'completed') continue;
    add(b.status, b.count);
    size += b.count;
  }
  for (const cp of folded) {
    const n = foldedCount(cp) ?? 1;
    add(isFailedMember(cp) ? 'failed' : cp.status, n);
    size += n;
  }
  const children = await failedChildren(store, runId, group, buckets);
  const failedChildSet = new Set(children.failed);
  for (const cp of children.completed) add(failedChildSet.has(cp) ? 'failed' : 'completed', 1);
  size += children.completed.length;

  const failedStatusRows = buckets.some((b) => b.status === 'failed')
    ? await store.queryCheckpoints(runId, {
        group,
        statuses: ['failed'],
        limit: FAN_SUMMARY_FAILURES,
      })
    : [];
  const failures = mergeBySeq(failedStatusRows, children.failed).slice(0, FAN_SUMMARY_FAILURES);

  const parsed = parseFanGroup(group);
  const total = parsed?.size;
  return {
    group,
    label: childRuns ? 'child runs' : minName === maxName ? (minName ?? '') : 'steps',
    firstSeq,
    lastSeq,
    size,
    total,
    notStarted: total === undefined ? undefined : Math.max(0, total - size),
    failFast: parsed?.failFast ?? false,
    counts,
    startedAt,
    finishedAt,
    failures,
  };
}

/**
 * The run's distinct child ids, as `loadRunDetail` lists them, read SUMMARY_CHILD_LIMIT edge rows at
 * a time until that many distinct ids are known. `complete` says every edge row was read, so `ids`
 * holds them all and their count is exact.
 */
async function firstChildIds(
  store: CheckpointAggregatingStore,
  runId: string,
): Promise<{ ids: string[]; complete: boolean }> {
  const ids = new Set<string>();
  for (let offset = 0; ; offset += SUMMARY_CHILD_LIMIT) {
    const page = await store.queryCheckpoints(runId, {
      namePrefixes: CHILD_EDGE_PREFIXES,
      offset,
      limit: SUMMARY_CHILD_LIMIT,
    });
    for (const id of childIdsOf(page)) ids.add(id);
    if (page.length < SUMMARY_CHILD_LIMIT) return { ids: [...ids], complete: true };
    if (ids.size >= SUMMARY_CHILD_LIMIT) return { ids: [...ids], complete: false };
  }
}

/**
 * What `summarizeTimeline` plus `childIdsOf` make of a run's whole checkpoint list, read through the
 * store's aggregates instead: the checkpoints outside wide fans, one {@link FanSummary} per wide fan,
 * and the run's children capped at {@link SUMMARY_CHILD_LIMIT} with their count.
 *
 * What it reads besides the aggregates: the rows outside wide fans, every folded `fan:` checkpoint
 * (one per settled wave), up to {@link FAN_SUMMARY_FAILURES} failed rows per wide fan, the first
 * child-edge rows, and — while a wide child fan is in flight — that fan's completed `signal:child:`
 * rows, whose `ok: false` payload is what marks a failed child.
 *
 * `childCount` is exact (distinct ids, as `loadRunDetail` counts them) while the run has few enough
 * child edges to read them all. Past that it adds up the edge rows and the folded ids without
 * de-duplicating, so a child both spawned and awaited counts twice.
 */
export async function summarizeRunFromStore(
  store: CheckpointAggregatingStore,
  runId: string,
  over: number,
  stats?: CheckpointStat[],
): Promise<{
  timeline: StepCheckpoint[];
  fans: FanSummary[];
  children: string[];
  childCount: number;
}> {
  const all = stats ?? (await store.checkpointStats(runId));
  const byGroup = new Map<string, CheckpointStat[]>();
  let edgeRows = 0;
  let hasFolded = false;
  for (const b of all) {
    if (b.nameKind === 'child' || b.nameKind === 'spawn') edgeRows += b.count;
    if (b.nameKind === 'folded') hasFolded = true;
    if (b.group === null) continue;
    const buckets = byGroup.get(b.group);
    if (buckets) buckets.push(b);
    else byGroup.set(b.group, [b]);
  }
  const wide = [...byGroup].filter(([group, buckets]) =>
    isWide(
      group,
      buckets.reduce((n, b) => n + b.count, 0),
      over,
    ),
  );
  const [timeline, folded, children] = await Promise.all([
    store.queryCheckpoints(runId, { excludeGroups: wide.map(([group]) => group) }),
    hasFolded ? store.queryCheckpoints(runId, { namePrefixes: [FOLDED_PREFIX] }) : [],
    edgeRows > 0 || hasFolded ? firstChildIds(store, runId) : { ids: [], complete: true },
  ]);
  const fans = await Promise.all(
    wide.map(([group, buckets]) =>
      summarizeFanFromStats(
        store,
        runId,
        group,
        buckets,
        folded.filter((cp) => cp.parallelGroup === group),
      ),
    ),
  );
  const childCount = children.complete
    ? children.ids.length
    : folded.reduce((n, cp) => n + childIdsOf([cp]).length, edgeRows);
  return {
    timeline,
    fans: fans.sort((a, b) => a.firstSeq - b.firstSeq),
    children: children.ids.slice(0, SUMMARY_CHILD_LIMIT),
    childCount,
  };
}

/** What `pageFan` makes of a run's whole checkpoint list, read one page at a time from the store. */
export async function pageFanFromStore(
  store: CheckpointAggregatingStore,
  runId: string,
  group: string,
  query: FanPageQuery,
  stats?: CheckpointStat[],
): Promise<FanPage> {
  const buckets = stats ?? (await store.checkpointStats(runId, { group }));
  const { offset, limit } = fanPageBounds(query);
  if (!query.failedOnly) {
    const total = buckets.reduce((n, b) => n + b.count, 0);
    const items =
      total > offset ? await store.queryCheckpoints(runId, { group, offset, limit }) : [];
    return { items, total };
  }
  const failedStatus = buckets
    .filter((b) => b.status === 'failed')
    .reduce((n, b) => n + b.count, 0);
  const children = await failedChildren(store, runId, group, buckets);
  const total = failedStatus + children.failed.length;
  if (total <= offset) return { items: [], total };
  if (children.failed.length === 0) {
    return {
      items: await store.queryCheckpoints(runId, { group, statuses: ['failed'], offset, limit }),
      total,
    };
  }
  // The page's members are among the first `offset + limit` of each kind of failure.
  const failedRows = await store.queryCheckpoints(runId, {
    group,
    statuses: ['failed'],
    limit: offset + limit,
  });
  return {
    items: mergeBySeq(failedRows, children.failed).slice(offset, offset + limit),
    total,
  };
}

/** A 53-bit string hash (cyrb53), as hex: enough to tell two fingerprints apart. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * The checkpoint half of a change marker. There is no per-checkpoint write version to read, so it
 * is the buckets themselves: every engine write to a checkpoint adds a row, moves a row to another
 * status bucket, or rewrites a row's timestamps or attempts — and each of those moves a bucket's
 * count, seq range, timestamp bounds or attempt sum.
 */
function statsFingerprint(stats: CheckpointStat[]): string {
  return stats
    .map((b) =>
      [
        b.group ?? '',
        b.status,
        b.nameKind,
        b.count,
        b.minSeq,
        b.maxSeq,
        b.minName,
        b.maxName,
        b.minEnqueuedAt.getTime(),
        b.minStartedAt.getTime(),
        b.maxStartedAt.getTime(),
        b.maxFinishedAt.getTime(),
        b.sumAttempts,
      ].join('\u0001'),
    )
    .sort()
    .join('\u0002');
}

/**
 * The ETag of a summarized run detail: the run row as read (so any run field that changes shows)
 * plus its checkpoint buckets, and the threshold it was summarized with.
 */
export function runDetailEtag(run: WorkflowRun, stats: CheckpointStat[], over: number): string {
  return `"rd-${hash(`${over}\u0003${JSON.stringify(run)}\u0003${statsFingerprint(stats)}`)}"`;
}

/** The ETag of one page of a fan: its group's buckets and the page asked for. */
export function fanPageEtag(group: string, stats: CheckpointStat[], query: FanPageQuery): string {
  const { offset, limit } = fanPageBounds(query);
  const key = [group, offset, limit, query.failedOnly === true].join('\u0001');
  return `"fp-${hash(`${key}\u0003${statsFingerprint(stats)}`)}"`;
}

/** Whether an `If-None-Match` header value names `etag` (weak comparison, as RFC 9110 asks for). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = bare(etag);
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || bare(tag) === target);
}

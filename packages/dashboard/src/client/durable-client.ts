/**
 * API client for the `@adonis-agora/durable` dashboard SPA. Talks JSON over `fetch` to the routes
 * mounted by `packages/adonis/providers/dashboard_provider.ts` (default base `/durable`, JSON API at
 * `<base>/api`).
 *
 * This is a from-scratch port of `@dudousxd/nestjs-durable-dashboard`'s `durable-client.ts`, kept
 * behaviourally identical wherever the AdonisJS engine exposes the same data (deliberate: every UI
 * component under `src/app/` was ported unedited and imports these exact names/shapes). Divergences
 * from the NestJS client are called out inline — the remaining known gaps are:
 *
 * 1. `WorkflowRun.origin` — the AdonisJS engine has no `origin` column, so `origin` is always
 *    `undefined` here. The origin facet UI (`OriginFacets.tsx`) still renders — every run just buckets
 *    under "unknown" until a future engine change adds the column. (`RunWaiting`/`waiting` is NO LONGER
 *    in this gap: the engine's `listSignalWaiters` bulk scan is wired into `GET /runs` — see
 *    `packages/adonis/src/dashboard/handlers.ts`'s `listRuns` — so a suspended run's list row DOES
 *    carry `waiting` the same as the NestJS console's, once the server is new enough.)
 * 2. `WorkerHeartbeat.status` (rss/cpu/concurrency telemetry) — the AdonisJS engine's heartbeat carries
 *    no `WorkerStatus` payload (only `group`/`instanceId`/`lastBeatAt`), so worker cards never show the
 *    resource-usage details the NestJS console can. The types are kept so a future engine addition
 *    lights the UI up with no client change.
 */

// ── Wire types (independent of `@adonis-agora/durable`'s own `Date`-typed engine interfaces — the
// dashboard's `handlers.ts` serializes every `Date` to an ISO string before it reaches this client). ──

export type RunStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  /**
   * Saga compensation in progress. NOTE: the AdonisJS engine's `RunStatus` union (`interfaces.ts`)
   * does not produce this state today — `cancel()` settles straight to `cancelled` — so no run the
   * server sends will ever carry it. Kept in the client's own union anyway (rather than trimmed) so
   * the ported UI (`App.tsx`'s singleton in-flight set, status badges) stays byte-identical to the
   * NestJS console and lights up for free if a future engine version adds a visible compensating
   * status.
   */
  | 'cancelling'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'dead';

export type StepKind = 'local' | 'remote' | 'sleep' | 'signal';

export interface StepError {
  message: string;
  code?: string;
  retryable?: boolean;
  stack?: string;
}

export interface StepEvent {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  subId?: string;
  name?: string;
  group?: string;
  status?: 'ok' | 'failed' | 'skipped';
  phase?: string;
  process?: string;
  data?: unknown;
}

export interface StepCheckpoint {
  runId?: string;
  seq: number;
  name: string;
  kind: StepKind;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input?: unknown;
  output?: unknown;
  error?: StepError;
  attempts: number;
  workerGroup?: string;
  events?: StepEvent[];
  wakeAt?: number;
  /** Shared `all:<firstSeq>` tag grouping a `ctx.all`/`ctx.gather` fan-out's sibling checkpoints. */
  parallelGroup?: string;
  enqueuedAt?: string;
  startedAt: string;
  finishedAt: string;
}

/** What a suspended run is parked on — populated on `GET /runs` list rows via the server's bulk
 *  signal-waiter scan (see module doc). Absent on a server too old to have it (or a store-less
 *  `tenant` pod that can't do the scan), in which case `deriveRunState` falls back to its other
 *  signals (timeline, worker health) instead of the "awaiting" detail line. */
export interface RunWaiting {
  on: 'signal' | 'webhook' | 'child' | 'breakpoint';
  name: string;
}

export interface WorkflowRun {
  id: string;
  workflow: string;
  workflowVersion: string;
  status: RunStatus;
  namespace?: string;
  input?: unknown;
  output?: unknown;
  error?: StepError;
  wakeAt?: number;
  recoveryAttempts?: number;
  tags?: string[];
  searchAttributes?: Record<string, string | number | boolean>;
  /** The package that declared the workflow. NOTE: always `undefined` today (gap #1). */
  origin?: string;
  createdAt: string;
  updatedAt: string;
  waiting?: RunWaiting;
}

export interface RunDetail {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  children?: string[];
}

/** This deployment's durable role — the AdonisJS engine has three (NestJS's `DurableTopology` only
 *  distinguishes `control-plane`/`tenant`; `standalone` is the single-process default here). */
export interface DurableTopology {
  role: 'control-plane' | 'standalone' | 'tenant';
  tenant?: string;
}

/** How a worker decides its concurrency. NOTE: not carried by the AdonisJS engine's heartbeat today
 *  (gap #2) — kept for forward compatibility, always absent on {@link WorkerHeartbeat.status}. */
export interface WorkerConcurrencyStatus {
  mode: 'fixed' | 'adaptive';
  limit: number;
  min?: number;
  max?: number;
}

export interface WorkerAdjust {
  at: number;
  from: number;
  to: number;
  reason: 'ram_ceiling' | 'cpu_ceiling' | 'backpressure' | 'grow' | 'shrink';
}

/** A live snapshot of a worker's execution state. NOTE: gap #2 — always absent today. */
export interface WorkerStatus {
  runtime?: 'node' | 'python';
  concurrency: WorkerConcurrencyStatus;
  inFlight: number;
  rssBytes?: number;
  rssLimitBytes?: number;
  rssPct?: number;
  cpuPct?: number;
  throughputPerMin?: number;
  p95Ms?: number;
  lastAdjust?: WorkerAdjust;
}

export interface WorkerHeartbeat {
  group: string;
  instanceId: string;
  lastBeatAt: number;
  status?: WorkerStatus;
}

export interface GroupHealth {
  group: string;
  depth: number;
  liveWorkers: WorkerHeartbeat[];
  kind?: 'workflow' | 'step';
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  output?: unknown;
  error?: StepError;
}

export interface EngineEvent {
  type:
    | 'run.started'
    | 'run.completed'
    | 'run.failed'
    | 'run.suspended'
    | 'step.started'
    | 'step.completed'
    | 'step.failed'
    | 'step.progress';
  runId: string;
  workflow?: string;
  seq?: number;
  name?: string;
  kind?: StepKind;
  durationMs?: number;
  event?: StepEvent;
  at: string;
}

// ── Run-state refinement (ported verbatim from the NestJS client's derivation logic — field names
// line up 1:1 with the AdonisJS engine's own `WorkflowRun`/`StepCheckpoint`/`GroupHealth`). ──────────

export const STALE_PENDING_MS = 10 * 60 * 1000; // 10 min

/** A remote step checkpoint `pending` longer than {@link STALE_PENDING_MS} — likely a lost dispatch. */
export function isStalePending(cp: StepCheckpoint, nowMs: number): boolean {
  if (cp.kind !== 'remote' || cp.status !== 'pending') return false;
  const dispatchedAt = cp.enqueuedAt
    ? new Date(cp.enqueuedAt).getTime()
    : new Date(cp.startedAt).getTime();
  return nowMs - dispatchedAt > STALE_PENDING_MS;
}

export type RunDisplayStatus = RunStatus | 'sleeping' | 'awaiting' | 'no-worker' | 'queued';

export interface RunDisplayState {
  status: RunDisplayStatus;
  detail?: string;
}

const SINGLETON_INFLIGHT = new Set<RunStatus>(['running', 'suspended', 'cancelling']);

/** Strip the route-by-handler `@partition` suffix so a run's `workflow` matches its `GroupHealth.group`. */
export function baseGroup(group: string): string {
  const at = group.lastIndexOf('@');
  return at === -1 ? group : group.slice(0, at);
}

function groupIsStalled(group: string, health: readonly GroupHealth[]): boolean {
  const base = baseGroup(group);
  const entries = health.filter((h) => baseGroup(h.group) === base);
  const anyBacklog = entries.some((h) => h.depth > 0);
  const anyWorker = entries.some((h) => h.liveWorkers.length > 0);
  return anyBacklog && !anyWorker;
}

function tokenDetail(token: string): string {
  if (token.startsWith('wh:')) return `webhook ${token}`;
  if (token.startsWith('child:')) return `child ${token.slice('child:'.length)}`;
  return `signal ${token}`;
}

export function singletonLeader(
  run: WorkflowRun,
  runs: readonly WorkflowRun[],
): WorkflowRun | undefined {
  const tag = run.tags?.find((t) => t.startsWith('singleton:'));
  if (!tag) return undefined;
  const inflight = runs
    .filter((r) => SINGLETON_INFLIGHT.has(r.status) && r.tags?.includes(tag))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return inflight[0];
}

function waitingDetail(waiting: RunWaiting): string {
  return `${waiting.on} ${waiting.name}`;
}

export function deriveRunState(
  run: WorkflowRun,
  ctx: {
    runs: readonly WorkflowRun[];
    health: readonly GroupHealth[];
    timeline?: readonly StepCheckpoint[];
  },
): RunDisplayState {
  if (run.status !== 'suspended') {
    if (run.status === 'pending' && groupIsStalled(run.workflow, ctx.health)) {
      return { status: 'no-worker', detail: run.workflow };
    }
    if (run.status === 'blocked') {
      return { status: 'no-worker', detail: run.workflow };
    }
    return { status: run.status };
  }

  const leader = singletonLeader(run, ctx.runs);
  if (leader && leader.id !== run.id) {
    return { status: 'queued', detail: `behind leader ${leader.id.slice(0, 8)}` };
  }

  const pending = ctx.timeline?.find((s) => s.status === 'pending' || s.status === 'running');
  if (pending) {
    if (pending.kind === 'signal') return { status: 'awaiting', detail: tokenDetail(pending.name) };
    if (pending.kind === 'sleep') return { status: 'sleeping' };
    if (pending.workerGroup && groupIsStalled(pending.workerGroup, ctx.health)) {
      return { status: 'no-worker', detail: baseGroup(pending.workerGroup) };
    }
    return { status: 'running' };
  }

  if (run.waiting) return { status: 'awaiting', detail: waitingDetail(run.waiting) };

  if (groupIsStalled(run.workflow, ctx.health))
    return { status: 'no-worker', detail: run.workflow };
  return { status: 'running' };
}

export function runDisplayStatus(run: WorkflowRun, timeline?: StepCheckpoint[]): RunDisplayStatus {
  if (run.status !== 'suspended') return run.status;
  if (timeline?.some((s) => s.status === 'pending' || s.status === 'running')) return 'running';
  if (run.wakeAt != null) return 'sleeping';
  if (timeline) return 'awaiting';
  return 'running';
}

// ── HTTP transport ─────────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    /** UI mount base (e.g. `/durable`) injected by the provider; falls back to `/durable`. */
    __DURABLE_BASE__?: string;
    /** JSON API base (e.g. `/durable/api`) injected by the provider; falls back to `<base>/api`. */
    __DURABLE_API__?: string;
  }
}

function uiBase(): string {
  // Checked with `typeof ... === 'string'` (not a truthy check): the provider injects `''` for a
  // root-mounted dashboard (`path: ''`), which is a deliberate, valid base — a truthy check would
  // silently fall through to the `/durable` default instead of honoring it.
  if (typeof window !== 'undefined' && typeof window.__DURABLE_BASE__ === 'string') {
    return window.__DURABLE_BASE__;
  }
  return '/durable';
}

function apiBase(): string {
  if (typeof window !== 'undefined' && typeof window.__DURABLE_API__ === 'string') {
    return window.__DURABLE_API__;
  }
  return `${uiBase()}/api`;
}

/** Best-effort read of an `{ error: 'unauthorized' }`/`{ auth: { modes } }` 401 body. The AdonisJS
 *  dashboard's session guard sends a plain `{ error: 'unauthorized' }` (no `modes` — it only has one
 *  auth surface, the built-in login page), so this always falls back to a bare navigation to `uiBase()`,
 *  which itself redirects to the login page server-side when `dashboardAuth` is configured. */
async function readAuthModes(res: Response): Promise<string[] | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || !('auth' in body)) return undefined;
    const auth = (body as { auth?: unknown }).auth;
    if (typeof auth !== 'object' || auth === null || !('modes' in auth)) return undefined;
    const modes = (auth as { modes?: unknown }).modes;
    return Array.isArray(modes)
      ? modes.filter((m): m is string => typeof m === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

function redirectToAuthSurface(modes: readonly string[] | undefined): void {
  if (typeof window === 'undefined') return;
  const base = uiBase();
  if (modes?.includes('login')) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${base}/login?returnTo=${returnTo}`;
    return;
  }
  window.location.href = base;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + path, init);
  if (res.status === 401) {
    redirectToAuthSurface(await readAuthModes(res));
    throw new Error('Session expired; redirecting to sign-in.');
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export interface RunFilterOptions {
  namespace?: string | undefined;
  /** See module doc gap #1 — cannot select unattributed runs, and no run carries an origin today. */
  origin?: string | undefined;
}

/** `offset`/`limit` for a `/runs` page request — mirrors `handlers.ts`'s `listRuns` query params
 *  (server caps `limit` at 200). Both optional; the server defaults `limit` to 50, `offset` to 0. */
export interface RunPageOptions {
  limit?: number;
  offset?: number;
}

/** One page of `/runs`, WITH the pagination metadata the plain {@link durableClient.runs} throws away.
 *  `page.count` is how many runs THIS page returned (not a total) — `count === page.limit` is the
 *  server's only "there might be more" signal, since it never counts the full match set. */
export interface RunsPage {
  runs: WorkflowRun[];
  page: { limit: number; offset: number; count: number };
}

interface RunsListResponse {
  runs: WorkflowRun[];
  page: { limit: number; offset: number; count: number };
  statuses: RunStatus[];
}

interface RunResponse {
  result: RunResult;
}

interface RetryWithInputResponse {
  result: { runId: string };
}

export const durableClient = {
  async runs(
    status?: RunStatus,
    tag?: string,
    attr?: string[],
    opts?: RunFilterOptions,
  ): Promise<WorkflowRun[]> {
    const { runs } = await durableClient.runsPage(status, tag, attr, opts);
    return runs;
  },
  /** Same filters as {@link runs}, plus real `limit`/`offset` paging — and, unlike {@link runs}, keeps
   *  the server's `page` metadata instead of discarding it, so a caller (the infinite-scrolling runs
   *  list) can tell whether another page might exist. */
  async runsPage(
    status?: RunStatus,
    tag?: string,
    attr?: string[],
    opts?: RunFilterOptions,
    page?: RunPageOptions,
  ): Promise<RunsPage> {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (tag) q.set('tag', tag);
    for (const a of attr ?? []) q.append('attr', a);
    if (opts?.namespace) q.set('namespace', opts.namespace);
    if (opts?.origin) q.set('origin', opts.origin);
    if (page?.limit !== undefined) q.set('limit', String(page.limit));
    if (page?.offset !== undefined) q.set('offset', String(page.offset));
    const qs = q.toString();
    const res = await http<RunsListResponse>(qs ? `/runs?${qs}` : '/runs');
    return { runs: res.runs, page: res.page };
  },
  run(id: string): Promise<RunDetail> {
    return http<RunDetail>(`/runs/${encodeURIComponent(id)}`);
  },
  /** Per-group worker health (queue backlog + live worker heartbeats) for the Workers panel. */
  workers(): Promise<GroupHealth[]> {
    return http<GroupHealth[]>('/workers');
  },
  topology(): Promise<DurableTopology> {
    return http<DurableTopology>('/topology');
  },
  async retry(id: string): Promise<RunResult> {
    const res = await http<RunResponse>(`/runs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
    return res.result;
  },
  /** Fix-and-replay: re-run a dead/failed run with a corrected input. Returns the new run's id. */
  async retryWithInput(id: string, input: unknown): Promise<{ runId: string }> {
    const res = await http<RetryWithInputResponse>(
      `/runs/${encodeURIComponent(id)}/retry-with-input`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      },
    );
    return res.result;
  },
  /** Bulk retry/cancel every run matching a filter. Returns how many matched + were acted on. */
  bulk(
    action: 'retry' | 'cancel',
    filter: RunFilterOptions & {
      status?: RunStatus | undefined;
      tag?: string | undefined;
      attr?: string[] | undefined;
      /** `cancel` only — run each matched run's saga compensations before cancelling it. */
      compensate?: boolean | undefined;
    },
  ): Promise<{ matched: number; applied: number }> {
    const q = new URLSearchParams();
    if (filter.compensate) q.set('compensate', 'true');
    if (filter.status) q.set('status', filter.status);
    if (filter.tag) q.set('tag', filter.tag);
    for (const a of filter.attr ?? []) q.append('attr', a);
    if (filter.namespace) q.set('namespace', filter.namespace);
    if (filter.origin) q.set('origin', filter.origin);
    const qs = q.toString();
    return http<{ matched: number; applied: number }>(`/bulk/${action}${qs ? `?${qs}` : ''}`, {
      method: 'POST',
    });
  },
  async cancel(id: string, opts?: { compensate?: boolean }): Promise<RunResult> {
    const qs = opts?.compensate ? '?compensate=true' : '';
    const res = await http<RunResponse>(`/runs/${encodeURIComponent(id)}/cancel${qs}`, {
      method: 'POST',
    });
    return res.result;
  },
  async continue(id: string): Promise<RunResult> {
    const res = await http<RunResponse>(`/runs/${encodeURIComponent(id)}/continue`, {
      method: 'POST',
    });
    return res.result;
  },
  /** Re-dispatch a run's stuck `pending` remote steps. Returns the run's status plus how many steps
   *  were re-dispatched. */
  async redispatch(
    id: string,
  ): Promise<{ runId: string; status: RunStatus; redispatched: number }> {
    const res = await http<{ result: { runId: string; status: RunStatus; redispatched: number } }>(
      `/runs/${encodeURIComponent(id)}/redispatch`,
      { method: 'POST' },
    );
    return res.result;
  },
  /** Live-tail a run's lifecycle events over SSE. Calls `onEvent` per event; returns a closer. */
  streamRun(id: string, onEvent: (event: EngineEvent) => void): () => void {
    const source = new EventSource(`${apiBase()}/runs/${encodeURIComponent(id)}/stream`);
    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as EngineEvent);
      } catch {
        /* ignore malformed event */
      }
    };
    return () => source.close();
  },
};

export {
  ConsoleSessionError,
  durableConsoleSessionUrl,
  durableConsoleUrl,
  mintDurableConsoleSession,
  openDurableConsole,
  type OpenConsoleOptions,
} from './console-session.js';

export { type SubProcess, groupSubProcesses } from './group-subprocesses.js';

export {
  ALL_ORIGINS,
  type EmptyRunsNotice,
  type OriginFacet,
  type OriginFilter,
  UNKNOWN_ORIGIN,
  UNKNOWN_ORIGIN_TITLE,
  emptyRunsNotice,
  filterByOrigin,
  isUnknownOrigin,
  knownOrigin,
  matchesOrigin,
  originFacets,
  originFilterKey,
  originLabel,
  sameOriginFilter,
  unknownOriginCount,
} from './run-origin.js';

export {
  type CompensationSummary,
  compensationDisplayName,
  compensationSummary,
  splitCompensations,
} from './split-compensations.js';

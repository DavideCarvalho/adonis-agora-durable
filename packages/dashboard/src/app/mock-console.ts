import type {
  DurableTopology,
  GroupHealth,
  RunDetail,
  StepCheckpoint,
  WorkflowRun,
} from '../client/durable-client';

/**
 * A hand-built snapshot of a live control plane, served to the SPA by stubbing `fetch`. Used only by
 * `preview.html?view=console` — the standalone visual-verification entry — so the WHOLE console
 * (header, filter chips, workers panel, run list, run detail, spans) can be screenshotted with its
 * real components and real styling, with no server, no database and no workers.
 *
 * It is deliberately a *representative* snapshot rather than a minimal one: several `completed`
 * (green) runs sit next to the green interactive affordances (accent logo, `retry all`, `Retry`) so a
 * screenshot can settle the accent-vs-status question in AVIARY-UI.md with evidence.
 *
 * It is also deliberately MIXED on the two provenance axes, because a snapshot where every run is
 * attributed would hide the case that matters: two runs (`inv-2b91ee70`, `bck-4410aa03`) carry no
 * `origin` at all — the "unknown" bucket a real deployment is mostly made of — and two sit in a named
 * tenant rather than `default`.
 */

const T0 = Date.parse('2026-07-29T09:14:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const runs: WorkflowRun[] = [
  {
    id: 'ord-9f2c1a4b',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'failed',
    namespace: 'default',
    origin: 'acme-storefront',
    createdAt: iso(-620_000),
    updatedAt: iso(-540_000),
    tags: ['tier:pro', 'region:us-east'],
    searchAttributes: { amount: 249, tier: 'pro' },
    input: { orderId: 'ord-9f2c1a4b', amount: 249, currency: 'USD' },
    error: { message: 'charge declined: card_expired (stripe: card_error)' },
  },
  {
    id: 'ord-77ab3012',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'completed',
    origin: 'acme-storefront',
    createdAt: iso(-1_800_000),
    updatedAt: iso(-1_744_000),
    tags: ['tier:free'],
    input: { orderId: 'ord-77ab3012', amount: 19 },
    output: { charged: true },
  },
  {
    id: 'inv-2b91ee70',
    workflow: 'invoiceSettlement',
    workflowVersion: '2',
    status: 'completed',
    createdAt: iso(-2_100_000),
    updatedAt: iso(-2_010_000),
    input: { invoice: 'INV-4471' },
  },
  {
    id: 'shp-01d4f7c9',
    workflow: 'shipmentSync',
    workflowVersion: '1',
    status: 'running',
    origin: '@adonis-agora/catalog-pipeline',
    createdAt: iso(-90_000),
    updatedAt: iso(-4_000),
    input: { carrier: 'dhl' },
  },
  {
    id: 'shp-55c2aa18',
    workflow: 'shipmentSync',
    workflowVersion: '1',
    status: 'completed',
    origin: '@adonis-agora/catalog-pipeline',
    createdAt: iso(-3_400_000),
    updatedAt: iso(-3_330_000),
    input: { carrier: 'ups' },
  },
  {
    id: 'rep-8812cd44',
    workflow: 'nightlyReport',
    workflowVersion: '7',
    status: 'suspended',
    namespace: 'acme',
    origin: '@adonis-agora/agent',
    createdAt: iso(-5_400_000),
    updatedAt: iso(-300_000),
    waiting: { on: 'signal', name: 'approve' },
    input: { day: '2026-07-28' },
  },
  {
    id: 'ord-1177fe22',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'completed',
    namespace: 'acme',
    origin: 'acme-storefront',
    createdAt: iso(-7_200_000),
    updatedAt: iso(-7_120_000),
    tags: ['tier:pro'],
    input: { orderId: 'ord-1177fe22', amount: 640 },
    output: { charged: true },
  },
  {
    id: 'bck-4410aa03',
    workflow: 'backfillLedger',
    workflowVersion: '1',
    status: 'cancelled',
    createdAt: iso(-9_000_000),
    updatedAt: iso(-8_880_000),
    input: { from: '2026-01-01' },
  },
  {
    id: 'ord-6650bb91',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'pending',
    origin: 'acme-storefront',
    createdAt: iso(-12_000),
    updatedAt: iso(-12_000),
    input: { orderId: 'ord-6650bb91', amount: 78 },
  },
];

const failedTimeline: StepCheckpoint[] = [
  {
    runId: 'ord-9f2c1a4b',
    seq: 1,
    name: 'reserveInventory',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    workerGroup: 'inventory',
    enqueuedAt: iso(-619_000),
    startedAt: iso(-618_200),
    finishedAt: iso(-615_900),
    input: { sku: 'SKU-8823', qty: 1 },
    output: { reservationId: 'rsv-77120' },
  },
  {
    runId: 'ord-9f2c1a4b',
    seq: 2,
    name: 'quoteShipping',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    workerGroup: 'shipping',
    enqueuedAt: iso(-615_800),
    startedAt: iso(-615_100),
    finishedAt: iso(-612_400),
    output: { carrier: 'dhl', cents: 890 },
  },
  {
    runId: 'ord-9f2c1a4b',
    seq: 3,
    name: 'chargeCard',
    kind: 'remote',
    status: 'failed',
    attempts: 3,
    workerGroup: 'payments',
    enqueuedAt: iso(-612_300),
    startedAt: iso(-611_800),
    finishedAt: iso(-540_000),
    input: { amount: 249, currency: 'USD' },
    error: { message: 'charge declined: card_expired (stripe: card_error)' },
    events: [
      { at: T0 - 611_700, level: 'info', message: 'attempt 1 → gateway timeout, retrying' },
      { at: T0 - 590_000, level: 'warn', message: 'attempt 2 → gateway timeout, retrying' },
      { at: T0 - 540_200, level: 'error', message: 'attempt 3 → card_expired, giving up' },
    ],
  },
];

/** An in-flight run: one settled step and one remote step a worker is running right now — the only
 *  shape that shows the graph's `--live` in-flight styling. */
const runningTimeline: StepCheckpoint[] = [
  {
    runId: 'shp-01d4f7c9',
    seq: 1,
    name: 'fetchManifest',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    workerGroup: 'shipping',
    enqueuedAt: iso(-89_000),
    startedAt: iso(-88_400),
    finishedAt: iso(-84_100),
    output: { parcels: 42 },
  },
  {
    runId: 'shp-01d4f7c9',
    seq: 2,
    name: 'syncCarrier',
    kind: 'remote',
    status: 'pending',
    attempts: 1,
    workerGroup: 'shipping',
    enqueuedAt: iso(-84_000),
    startedAt: iso(-83_600),
    finishedAt: iso(-4_000),
    input: { carrier: 'dhl', parcels: 42 },
  },
];

const detail: Record<string, RunDetail> = {
  'shp-01d4f7c9': { run: runs[3] as WorkflowRun, timeline: runningTimeline, children: [] },
  'ord-9f2c1a4b': {
    run: runs[0] as WorkflowRun,
    timeline: failedTimeline,
    children: [],
  },
};

const workers: GroupHealth[] = [
  {
    group: 'checkout',
    kind: 'workflow',
    depth: 0,
    liveWorkers: [
      {
        group: 'checkout',
        instanceId: 'api-7f9c4d-2',
        lastBeatAt: T0 - 2_000,
        status: {
          runtime: 'node',
          concurrency: { mode: 'adaptive', limit: 16, min: 4, max: 32 },
          inFlight: 3,
          rssPct: 41,
          cpuPct: 22,
          throughputPerMin: 118,
          p95Ms: 740,
          lastAdjust: { at: T0 - 61_000, from: 12, to: 16, reason: 'grow' },
        },
      },
    ],
  },
  {
    group: 'payments',
    kind: 'step',
    depth: 2,
    liveWorkers: [
      {
        group: 'payments',
        instanceId: 'worker-payments-5b81',
        lastBeatAt: T0 - 3_500,
        status: {
          runtime: 'node',
          concurrency: { mode: 'fixed', limit: 8 },
          inFlight: 7,
          rssPct: 88,
          cpuPct: 63,
          throughputPerMin: 44,
          p95Ms: 2_310,
        },
      },
    ],
  },
  {
    group: 'inventory',
    kind: 'step',
    depth: 0,
    liveWorkers: [
      {
        group: 'inventory',
        instanceId: 'worker-inventory-11ce',
        lastBeatAt: T0 - 1_200,
        status: {
          runtime: 'python',
          concurrency: { mode: 'fixed', limit: 4 },
          inFlight: 1,
        },
      },
    ],
  },
  { group: 'shipping', kind: 'step', depth: 6, liveWorkers: [] },
];

const topology: DurableTopology = { role: 'control-plane' };

/** The full status union, mirroring the server's `GET /runs` envelope. */
const STATUSES: WorkflowRun['status'][] = [
  'pending',
  'running',
  'suspended',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'dead',
];

/** Coerce a query-string operand the way the server does: booleans, numbers, else the raw string. */
function coerceOperand(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** One `attr=key:op:value` predicate against a run's search attributes (mirror of the server). */
function matchesAttr(run: WorkflowRun, entry: string): boolean {
  const [key, op, ...rest] = entry.split(':');
  if (!key || !op || rest.length === 0) return true;
  const attrs = run.searchAttributes;
  if (!attrs || !(key in attrs)) return false;
  const actual = attrs[key] as string | number | boolean;
  const operand = rest.join(':');
  switch (op) {
    case 'eq':
      return actual === coerceOperand(operand);
    case 'ne':
      return actual !== coerceOperand(operand);
    case 'gt':
      return actual > coerceOperand(operand);
    case 'gte':
      return actual >= coerceOperand(operand);
    case 'lt':
      return actual < coerceOperand(operand);
    case 'lte':
      return actual <= coerceOperand(operand);
    case 'in':
      return operand
        .split('|')
        .filter((part) => part !== '')
        .map(coerceOperand)
        .some((v) => actual === v);
    default:
      return true;
  }
}

/** The server-side predicates the console can send: exact match, ANDed, absent = don't narrow. */
function scopedRuns(params: URLSearchParams, dropStatus: boolean): WorkflowRun[] {
  const status = dropStatus ? null : params.get('status');
  return runs.filter(
    (r) =>
      (!status || r.status === status) &&
      // A repeated param is the union; a run with NO origin matches no origin value.
      (!params.get('origin') || r.origin === params.get('origin')) &&
      (params.getAll('tag').length === 0 ||
        params.getAll('tag').some((t) => r.tags?.includes(t))) &&
      (params.getAll('namespace').length === 0 ||
        params.getAll('namespace').some((n) => (r.namespace ?? 'default') === n)) &&
      params.getAll('attr').every((entry) => matchesAttr(r, entry)),
  );
}

/** The values one snapshot run contributes to a picker axis. */
function valuesOf(run: WorkflowRun, field: string): Array<string | null> {
  if (field === 'tag') return run.tags ?? [];
  if (field === 'namespace') return run.namespace === undefined ? [] : [run.namespace];
  if (field === 'workflow') return [run.workflow];
  if (field === 'status') return [run.status];
  if (field === 'attr') return Object.keys(run.searchAttributes ?? {});
  if (field.startsWith('attr.')) {
    const value = run.searchAttributes?.[field.slice('attr.'.length)];
    return value === undefined ? [] : [String(value)];
  }
  return [];
}

function body(path: string): unknown | undefined {
  const [route, search] = path.split('?');
  const params = new URLSearchParams(search ?? '');
  if (route === '/runs') {
    // The real envelope (`{ runs, page, statuses}`), with the same predicate semantics as the
    // server — otherwise the tenant/tag/attr boxes in the preview would look broken, and a
    // screenshot of them would be a lie.
    const limit = Math.min(Math.max(Number(params.get('limit') ?? 50) || 0, 0), 200);
    const offset = Math.max(Number(params.get('offset') ?? 0) || 0, 0);
    const matching = scopedRuns(params, false).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return {
      runs: matching.slice(offset, offset + limit),
      page: { limit, offset, count: Math.min(limit, Math.max(matching.length - offset, 0)) },
      statuses: STATUSES,
    };
  }
  if (route === '/runs/values') {
    // What the pickers list: distinct values over the runs matching every OTHER predicate, with
    // counts — most common first, engine-minted tags last, searched before the bound.
    const field = params.get('groupByCount[field]') ?? params.get('field') ?? '';
    const needle = (params.get('groupByCount[search]') ?? params.get('search') ?? '')
      .trim()
      .toLowerCase();
    const limit = Math.min(
      Math.max(Number(params.get('groupByCount[limit]') ?? params.get('limit') ?? 100) || 0, 0),
      200,
    );
    const offset = Math.max(
      Number(params.get('groupByCount[offset]') ?? params.get('offset') ?? 0) || 0,
      0,
    );
    const counts = new Map<string | null, number>();
    for (const run of scopedRuns(params, true)) {
      for (const value of valuesOf(run, field)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .filter((row) => !needle || row.value?.toLowerCase().includes(needle))
      .sort((a, b) => {
        const engineA = a.value?.startsWith('singleton:') ?? false;
        const engineB = b.value?.startsWith('singleton:') ?? false;
        if (engineA !== engineB) return engineA ? 1 : -1;
        if (b.count !== a.count) return b.count - a.count;
        if (a.value === null) return 1;
        if (b.value === null) return -1;
        return (a.value ?? '').localeCompare(b.value ?? '');
      })
      .slice(offset, offset + limit);
  }
  if (route === '/workers') return workers;
  if (route === '/topology') return topology;
  const run = route?.match(/^\/runs\/(.+)$/)?.[1];
  if (run) {
    const id = decodeURIComponent(run);
    return (
      detail[id] ?? {
        run: runs.find((r) => r.id === id),
        timeline: [],
        children: [],
      }
    );
  }
  return undefined;
}

/**
 * Point the SPA's `fetch` at the snapshot above. Anything outside the durable API (fonts, assets) is
 * handed back to the real `fetch`, so the page still loads normally.
 */
export function installMockConsoleApi(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = url.match(/\/durable\/api(\/.*)$/);
    const payload = match?.[1] ? body(match[1]) : undefined;
    if (payload === undefined) return real(input as RequestInfo, init);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

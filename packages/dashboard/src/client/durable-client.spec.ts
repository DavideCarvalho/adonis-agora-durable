import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DurableActionError,
  deriveRunState,
  durableClient,
  type WorkflowRun,
  waitingOnTokens,
} from './durable-client.js';

/** A fake `Window`, just enough of the surface `durable-client.ts` touches. Shadows jsdom's real
 *  `window` for the scope of a test so a `location.href` assignment never triggers a real (jsdom)
 *  navigation — matches `@dudousxd/nestjs-durable-dashboard`'s own client spec's approach. */
interface FakeWindow {
  __DURABLE_BASE__?: string;
  __DURABLE_API__?: string;
  location: { href: string; pathname: string; search: string };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('durableClient: unwrapping the AdonisJS backend response envelopes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('unwraps GET /runs { runs, page, statuses } to a bare WorkflowRun[]', async () => {
    const run = { id: 'r1', workflow: 'w', workflowVersion: '1', status: 'completed' as const };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ runs: [run], page: { page: 1, size: 50, count: 1 }, statuses: [] }, 200),
        ),
    );
    await expect(durableClient.runs()).resolves.toEqual([run]);
  });

  it('unwraps a POST action { result } envelope to the bare RunResult', async () => {
    const result = { runId: 'r1', status: 'pending' as const };
    // A fresh `Response` per call — a `Response` body can only be read once, and `mockResolvedValue`
    // would otherwise hand the same already-consumed instance to every call below.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ result }, 200))),
    );
    await expect(durableClient.retry('r1')).resolves.toEqual(result);
    await expect(durableClient.cancel('r1')).resolves.toEqual(result);
    await expect(durableClient.continue('r1')).resolves.toEqual(result);
  });

  it('unwraps retry-with-input to { runId }', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ result: { runId: 'r1~retry~abc' } }, 200)),
    );
    await expect(durableClient.retryWithInput('r1', { fixed: true })).resolves.toEqual({
      runId: 'r1~retry~abc',
    });
  });

  it('workers() and topology() are NOT wrapped — the AdonisJS backend returns them bare', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse([{ group: 'g', depth: 0, liveWorkers: [] }], 200)),
    );
    await expect(durableClient.workers()).resolves.toEqual([
      { group: 'g', depth: 0, liveWorkers: [] },
    ]);
  });

  it('compat() hits GET /compat and returns the report bare — the server sends it unwrapped', async () => {
    const report = {
      controlPlane: { instanceId: 'cp', protocol: 1, protocolRange: [1, 1], capabilities: [] },
      groups: [],
      blocked: [],
      incompatibleCount: 0,
      blockedCount: 0,
    };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(jsonResponse(report, 200));
      }),
    );
    await expect(durableClient.compat()).resolves.toEqual(report);
    expect(calls[0]).toBe('/durable/api/compat');
  });
});

describe('durableClient: human-in-the-loop verbs (signal / update / task) and schedules', () => {
  afterEach(() => vi.unstubAllGlobals());

  function capture(response: () => Response): { calls: { url: string; init?: RequestInit }[] } {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, ...(init !== undefined ? { init } : {}) });
        return Promise.resolve(response());
      }),
    );
    return { calls };
  }

  it('signal posts { token, payload } and unwraps the { result } envelope', async () => {
    const { calls } = capture(() =>
      jsonResponse({ result: { runId: 'r1', status: 'running' } }, 200),
    );
    await expect(durableClient.signal('r1', 'approve', { ok: true })).resolves.toEqual({
      runId: 'r1',
      status: 'running',
    });
    expect(calls[0]?.url).toBe('/durable/api/runs/r1/signal');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      token: 'approve',
      payload: { ok: true },
    });
  });

  it('an undefined payload never reaches the wire (JSON.stringify drops it — not sent as null)', async () => {
    const { calls } = capture(() =>
      jsonResponse({ result: { runId: 'r1', status: 'running' } }, 200),
    );
    await durableClient.signal('r1', 'approve');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ token: 'approve' });
  });

  it("a signal 409 throws a DurableActionError whose body carries the run's waitingOn tokens", async () => {
    capture(() =>
      jsonResponse({ error: 'run r1 is not waiting on "typo"', waitingOn: ['approve'] }, 409),
    );
    const failure = await durableClient.signal('r1', 'typo').then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(DurableActionError);
    expect((failure as DurableActionError).status).toBe(409);
    expect((failure as DurableActionError).message).toBe('run r1 is not waiting on "typo"');
    expect(waitingOnTokens(failure)).toEqual(['approve']);
    // The helper answers undefined for anything that is not a token-carrying refusal.
    expect(waitingOnTokens(new Error('plain'))).toBeUndefined();
  });

  it("an update 422 throws with the validator's reason as the message (nothing was delivered)", async () => {
    const { calls } = capture(() =>
      jsonResponse(
        {
          error: 'limit must be positive',
          result: { accepted: false, reason: 'limit must be positive' },
        },
        422,
      ),
    );
    await expect(durableClient.update('r1', 'set-limit', { limit: -1 })).rejects.toThrow(
      'limit must be positive',
    );
    expect(calls[0]?.url).toBe('/durable/api/runs/r1/update/set-limit');
  });

  it('completeTask/failTask keep the { result, delivered } envelope — buffered is a success, not a miss', async () => {
    const { calls } = capture(() => jsonResponse({ result: null, delivered: false }, 200));
    await expect(durableClient.completeTask('r1', 'qa', { ok: true })).resolves.toEqual({
      result: null,
      delivered: false,
    });
    await expect(durableClient.failTask('r1', 'qa', 'rejected by reviewer')).resolves.toEqual({
      result: null,
      delivered: false,
    });
    expect(calls[0]?.url).toBe('/durable/api/runs/r1/tasks/qa/complete');
    expect(calls[1]?.url).toBe('/durable/api/runs/r1/tasks/qa/fail');
    expect(JSON.parse(calls[1]?.init?.body as string)).toEqual({ error: 'rejected by reviewer' });
  });

  it('schedules() unwraps GET /schedules { schedules } to the bare ScheduleInfo[]', async () => {
    const row = {
      key: 'nightly',
      workflow: 'nightlyReport',
      cron: '0 3 * * *',
      paused: false,
      pausedAtRuntime: false,
      lastFireAt: 1,
      nextFireAt: 2,
      currentWindowRunId: 'w1',
    };
    const { calls } = capture(() => jsonResponse({ schedules: [row] }, 200));
    await expect(durableClient.schedules()).resolves.toEqual([row]);
    expect(calls[0]?.url).toBe('/durable/api/schedules');
  });

  it('setSchedulePaused posts pause/resume and triggerSchedule unwraps the started run', async () => {
    const { calls } = capture(() =>
      jsonResponse(
        { key: 'nightly', paused: true, result: { runId: 'w1', status: 'running' } },
        200,
      ),
    );
    await durableClient.setSchedulePaused('nightly', true);
    await durableClient.setSchedulePaused('nightly', false);
    await expect(durableClient.triggerSchedule('nightly')).resolves.toEqual({
      runId: 'w1',
      status: 'running',
    });
    expect(calls.map((c) => c.url)).toEqual([
      '/durable/api/schedules/nightly/pause',
      '/durable/api/schedules/nightly/resume',
      '/durable/api/schedules/nightly/trigger',
    ]);
    expect(calls.every((c) => c.init?.method === 'POST')).toBe(true);
  });
});

describe('deriveRunState: `blocked` is a first-class display state', () => {
  const blockedRun: WorkflowRun = {
    id: 'r1',
    workflow: 'transcode',
    workflowVersion: '1',
    status: 'blocked',
    error: { message: "no compatible worker: requires capability 'step.stream'" },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps `blocked` instead of folding it into the generic no-worker badge, with the reason as detail', () => {
    expect(deriveRunState(blockedRun, { runs: [blockedRun], health: [] })).toEqual({
      status: 'blocked',
      detail: "no compatible worker: requires capability 'step.stream'",
    });
  });

  it('falls back to the workflow name when the run carries no error reason', () => {
    const { error: _error, ...bare } = blockedRun;
    expect(deriveRunState(bare, { runs: [bare], health: [] })).toEqual({
      status: 'blocked',
      detail: 'transcode',
    });
  });
});

describe('durableClient: the run-list / bulk query string', () => {
  function captureUrl(): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          jsonResponse({ runs: [], page: { page: 1, size: 50, count: 0 }, statuses: [] }, 200),
        );
      }),
    );
    return { calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('sends no namespace param by default — every tenant, as the console has always shown', async () => {
    const { calls } = captureUrl();
    await durableClient.runs();
    expect(calls[0]).toBe('/durable/api/runs');
  });

  it('drops an empty namespace/origin rather than filtering on the empty string', async () => {
    const { calls } = captureUrl();
    await durableClient.runs(undefined, undefined, undefined, { namespace: '', origin: '' });
    expect(calls[0]).toBe('/durable/api/runs');
  });

  it('sends the tag/namespace/attr the operator chose, as a filter envelope', async () => {
    const { calls } = captureUrl();
    await durableClient.runs(undefined, 'tier:pro', ['amount:gte:200'], { namespace: 'acme' });
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('filter[tag]')).toBe('tier:pro');
    expect(query.get('filter[namespace]')).toBe('acme');
    expect(query.get('filter[attr]')).toBe('amount:gte:200');
  });

  it('scopes a bulk action by the same facets, so it cannot reach wider than the list', async () => {
    const { calls } = captureUrl();
    await durableClient.bulk('cancel', { status: 'dead', namespace: 'acme' });
    expect(calls[0]).toMatch(/^\/durable\/api\/bulk\/cancel\?/);
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('filter[status]')).toBe('dead');
    expect(query.get('filter[namespace]')).toBe('acme');
  });
});

describe('durableClient.runsPage: real pagination (unlike runs(), keeps the page metadata)', () => {
  function captureUrl(): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          jsonResponse({ runs: [], page: { page: 1, size: 50, count: 0 }, statuses: [] }, 200),
        );
      }),
    );
    return { calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('sends page/size when given, and returns the page metadata instead of discarding it', async () => {
    const run = { id: 'r1', workflow: 'w', workflowVersion: '1', status: 'completed' as const };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          jsonResponse({ runs: [run], page: { page: 2, size: 100, count: 1 }, statuses: [] }, 200),
        );
      }),
    );

    const page = await durableClient.runsPage(undefined, undefined, undefined, undefined, {
      page: 2,
      size: 100,
    });

    expect(page).toEqual({ runs: [run], page: { page: 2, size: 100, count: 1 } });
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('page')).toBe('2');
    expect(query.get('size')).toBe('100');
  });

  it('omits page/size when no paging is given, so the server keeps its own defaults', async () => {
    const { calls } = captureUrl();
    await durableClient.runsPage();
    expect(calls[0]).toBe('/durable/api/runs');
  });

  it('combines paging with the same status/tag/attr/namespace/origin filters runs() sends', async () => {
    const { calls } = captureUrl();
    await durableClient.runsPage(
      'failed',
      'tier:pro',
      ['amount:gte:200'],
      { namespace: 'acme', origin: '@scope/pkg' },
      { page: 3, size: 25 },
    );
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('filter[status]')).toBe('failed');
    expect(query.get('filter[tag]')).toBe('tier:pro');
    expect(query.get('filter[attr]')).toBe('amount:gte:200');
    expect(query.get('filter[namespace]')).toBe('acme');
    expect(query.get('filter[origin]')).toBe('@scope/pkg');
    expect(query.get('page')).toBe('3');
    expect(query.get('size')).toBe('25');
  });

  it('runs() is a thin wrapper over runsPage() — same envelope-unwrapping, no page params sent', async () => {
    const { calls } = captureUrl();
    await durableClient.runs('failed', 'tier:pro');
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('page')).toBeNull();
    expect(query.get('size')).toBeNull();
  });

  it('sends a tag/namespace SET as a filter in-list, so a multi-select filters to the union', async () => {
    const { calls } = captureUrl();
    await durableClient.runs(undefined, ['etl', 'nightly'], undefined, {
      namespace: ['acme', 'globex'],
    });
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.getAll('filter[tag][]')).toEqual(['etl', 'nightly']);
    expect(query.getAll('filter[namespace][]')).toEqual(['acme', 'globex']);
  });

  it('sends the workflow filter (scalar and set) — the workflow picker rides the same envelope', async () => {
    const { calls } = captureUrl();
    await durableClient.runsPage(undefined, undefined, undefined, { workflow: 'checkout' });
    await durableClient.runsPage(undefined, undefined, undefined, {
      workflow: ['checkout', 'shipmentSync'],
    });
    const scalar = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(scalar.get('filter[workflow]')).toBe('checkout');
    const set = new URLSearchParams(calls[1]?.split('?')[1] ?? '');
    expect(set.getAll('filter[workflow][]')).toEqual(['checkout', 'shipmentSync']);
  });

  it('scopes a bulk action by the workflow filter too, so bulk and list can never disagree on it', async () => {
    const { calls } = captureUrl();
    await durableClient.bulk('retry', { status: 'failed', workflow: 'checkout' });
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('filter[status]')).toBe('failed');
    expect(query.get('filter[workflow]')).toBe('checkout');
  });
});

describe('durableClient.values: the picker enumeration', () => {
  function captureRows(): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          new Response(JSON.stringify([{ value: 'etl', count: 2 }]), { status: 200 }),
        );
      }),
    );
    return { calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('asks for the field scoped by the OTHER filters, with search/limit/offset', async () => {
    const { calls } = captureRows();
    const rows = await durableClient.values(
      'tag',
      { namespace: ['acme'], attr: ['tier:eq:pro'] },
      { limit: 50, offset: 50, search: 'et' },
    );
    expect(rows).toEqual([{ value: 'etl', count: 2 }]);
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(calls[0]).toMatch(/^\/durable\/api\/runs\/values\?/);
    expect(query.get('groupByCount[field]')).toBe('tag');
    expect(query.get('filter[namespace]')).toBe('acme');
    expect(query.get('filter[attr]')).toBe('tier:eq:pro');
    expect(query.get('groupByCount[search]')).toBe('et');
    expect(query.get('groupByCount[limit]')).toBe('50');
    expect(query.get('groupByCount[offset]')).toBe('50');
  });

  it('omits paging/search when the picker did not ask for them', async () => {
    const { calls } = captureRows();
    await durableClient.values('attr.tier', {});
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('groupByCount[field]')).toBe('attr.tier');
    expect(query.get('groupByCount[limit]')).toBeNull();
    expect(query.get('groupByCount[offset]')).toBeNull();
    expect(query.get('groupByCount[search]')).toBeNull();
  });
});

describe('durableClient: 401 handling (session gone mid-console)', () => {
  beforeEach(() => {
    (globalThis as { window?: FakeWindow }).window = {
      __DURABLE_BASE__: '/durable',
      location: { href: '', pathname: '/durable/runs/abc', search: '?tab=timeline' },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: FakeWindow }).window;
    vi.unstubAllGlobals();
  });

  it('sends the operator to the login page (with returnTo) when the server offers Mode B', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'unauthorized', auth: { modes: ['login'] } }, 401),
        ),
    );

    await expect(durableClient.runs()).rejects.toThrow();

    const win = (globalThis as unknown as { window: FakeWindow }).window;
    expect(win.location.href).toBe(
      '/durable/login?returnTo=%2Fdurable%2Fruns%2Fabc%3Ftab%3Dtimeline',
    );
  });

  it('sends the operator to the UI mount when only session mode (Mode A) is offered', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'unauthorized', auth: { modes: ['session'] } }, 401),
        ),
    );

    await expect(durableClient.runs()).rejects.toThrow();

    const win = (globalThis as unknown as { window: FakeWindow }).window;
    expect(win.location.href).toBe('/durable');
  });

  it("falls back to the UI mount on a bare 401 with no auth info (today's unauthenticated-by-default dashboard)", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401)));

    await expect(durableClient.runs()).rejects.toThrow();

    const win = (globalThis as unknown as { window: FakeWindow }).window;
    expect(win.location.href).toBe('/durable');
  });
});

describe('durableClient: root-mounted base (path: "")', () => {
  afterEach(() => {
    delete (globalThis as { window?: FakeWindow }).window;
    vi.unstubAllGlobals();
  });

  it('honors an explicitly injected empty base rather than falling back to /durable', async () => {
    (globalThis as { window?: FakeWindow }).window = {
      __DURABLE_BASE__: '',
      location: { href: '', pathname: '/runs/abc', search: '' },
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'unauthorized', auth: { modes: ['login'] } }, 401),
        ),
    );

    await expect(durableClient.runs()).rejects.toThrow();

    const win = (globalThis as unknown as { window: FakeWindow }).window;
    expect(win.location.href).toBe('/login?returnTo=%2Fruns%2Fabc');
  });
});

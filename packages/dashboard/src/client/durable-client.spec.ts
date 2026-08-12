import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { durableClient } from './durable-client.js';

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
          jsonResponse(
            { runs: [run], page: { limit: 50, offset: 0, count: 1 }, statuses: [] },
            200,
          ),
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
});

describe('durableClient: the run-list / bulk query string', () => {
  function captureUrl(): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          jsonResponse({ runs: [], page: { limit: 50, offset: 0, count: 0 }, statuses: [] }, 200),
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

  it('sends the tag/namespace/attr the operator chose', async () => {
    const { calls } = captureUrl();
    await durableClient.runs(undefined, 'tier:pro', ['amount:gte:200'], { namespace: 'acme' });
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('tag')).toBe('tier:pro');
    expect(query.get('namespace')).toBe('acme');
    expect(query.getAll('attr')).toEqual(['amount:gte:200']);
  });

  it('scopes a bulk action by the same facets, so it cannot reach wider than the list', async () => {
    const { calls } = captureUrl();
    await durableClient.bulk('cancel', { status: 'dead', namespace: 'acme' });
    expect(calls[0]).toMatch(/^\/durable\/api\/bulk\/cancel\?/);
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('status')).toBe('dead');
    expect(query.get('namespace')).toBe('acme');
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
          jsonResponse({ runs: [], page: { limit: 50, offset: 0, count: 0 }, statuses: [] }, 200),
        );
      }),
    );
    return { calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('sends limit/offset when given, and returns the page metadata instead of discarding it', async () => {
    const run = { id: 'r1', workflow: 'w', workflowVersion: '1', status: 'completed' as const };
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(
          jsonResponse(
            { runs: [run], page: { limit: 100, offset: 100, count: 1 }, statuses: [] },
            200,
          ),
        );
      }),
    );

    const page = await durableClient.runsPage(undefined, undefined, undefined, undefined, {
      limit: 100,
      offset: 100,
    });

    expect(page).toEqual({ runs: [run], page: { limit: 100, offset: 100, count: 1 } });
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('limit')).toBe('100');
    expect(query.get('offset')).toBe('100');
  });

  it('omits limit/offset when no paging is given, so the server keeps its own defaults', async () => {
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
      { limit: 25, offset: 50 },
    );
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('status')).toBe('failed');
    expect(query.get('tag')).toBe('tier:pro');
    expect(query.getAll('attr')).toEqual(['amount:gte:200']);
    expect(query.get('namespace')).toBe('acme');
    expect(query.get('origin')).toBe('@scope/pkg');
    expect(query.get('limit')).toBe('25');
    expect(query.get('offset')).toBe('50');
  });

  it('runs() is a thin wrapper over runsPage() — same envelope-unwrapping, no page params sent', async () => {
    const { calls } = captureUrl();
    await durableClient.runs('failed', 'tier:pro');
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('limit')).toBeNull();
    expect(query.get('offset')).toBeNull();
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
    // biome-ignore lint/performance/noDelete: test cleanup restoring the real (jsdom) window.
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
    // biome-ignore lint/performance/noDelete: test cleanup.
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

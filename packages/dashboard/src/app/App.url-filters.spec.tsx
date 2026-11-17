// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunDetail, RunsPage } from '../client/durable-client';
import { parseRoute } from './routes';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

/** Same happy-dom layout-measurement workaround as `RunsList.spec.tsx`. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
let restoreOffsetHeight: () => void;
let restoreOffsetWidth: () => void;
function stubElementSize() {
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 96 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 340 });
  restoreOffsetHeight = () =>
    heightDesc
      ? Object.defineProperty(HTMLElement.prototype, 'offsetHeight', heightDesc)
      : undefined;
  restoreOffsetWidth = () =>
    widthDesc ? Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDesc) : undefined;
}

const runsPage =
  vi.fn<
    (
      status?: string,
      tag?: string[],
      attr?: string[],
      opts?: { namespace?: string[]; workflow?: string[] },
      page?: { page?: number; size?: number },
    ) => Promise<RunsPage>
  >();
const getRun = vi.fn<(id: string) => Promise<RunDetail>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      run: (id: string) => getRun(id),
      runsPage: (...args: Parameters<typeof runsPage>) => runsPage(...args),
      values: vi.fn().mockResolvedValue([]),
      workers: vi.fn().mockResolvedValue([]),
      topology: vi.fn().mockResolvedValue({ role: 'standalone' }),
      compat: vi.fn().mockResolvedValue({
        controlPlane: { instanceId: 'cp', protocol: 1, protocolRange: [1, 1], capabilities: [] },
        groups: [],
        blocked: [],
        incompatibleCount: 0,
        blockedCount: 0,
      }),
    },
  };
});

// Imported AFTER the mock so `App` picks up the mocked `durableClient`.
const { App } = await import('./App');
const { originParam } = await import('./runs/RunsPage');

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPTY: RunsPage = {
  data: [],
  meta: { total: 0, perPage: 100, currentPage: 1, lastPage: 1, firstPage: 1 },
};

function detail(id: string): RunDetail {
  return {
    run: {
      id,
      workflow: 'shared-flow',
      workflowVersion: '1',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    timeline: [],
    children: [],
  };
}

/** Point the test environment at `url` without a navigation. */
function goTo(url: string) {
  window.history.replaceState(null, '', url);
}

function chip(status: string): HTMLElement {
  const label = screen.getByRole('toolbar', { name: 'filter runs by status' });
  const button = [...label.querySelectorAll('button')].find(
    (b) => b.querySelector('.uppercase')?.textContent === status,
  );
  if (!button) throw new Error(`no ${status} chip`);
  return button;
}

/** The status / tag the board last asked the server for. */
function lastRunsQuery() {
  const call = runsPage.mock.calls.at(-1);
  return { status: call?.[0], tag: call?.[1] };
}

describe('App: the runs board filters live in the URL', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    runsPage.mockReset();
    runsPage.mockResolvedValue(EMPTY);
    getRun.mockReset();
    getRun.mockImplementation((id) => Promise.resolve(detail(id)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
  });

  it('opens filtered from a shared link', async () => {
    goTo('/durable#?status=failed&tag=vip,beta');
    render(<App />, { wrapper });
    await waitFor(() =>
      expect(lastRunsQuery()).toEqual({ status: 'failed', tag: ['vip', 'beta'] }),
    );
    expect(chip('failed').getAttribute('aria-pressed')).toBe('true');
  });

  it('a status pick writes the URL (keeping the page path) and back undoes it', async () => {
    goTo('/durable?tenant=acme');
    render(<App />, { wrapper });
    await waitFor(() => expect(runsPage).toHaveBeenCalled());

    fireEvent.click(chip('failed'));
    await waitFor(() => expect(window.location.hash).toBe('#?status=failed'));
    expect(window.location.pathname).toBe('/durable');
    expect(window.location.search).toBe('?tenant=acme');
    await waitFor(() => expect(lastRunsQuery().status).toBe('failed'));

    // Back to "all": the default leaves the URL.
    fireEvent.click(chip('all'));
    await waitFor(() => expect(window.location.hash).toBe(''));
    await waitFor(() => expect(lastRunsQuery().status).toBeUndefined());

    act(() => window.history.back());
    await waitFor(() => expect(chip('failed').getAttribute('aria-pressed')).toBe('true'));
  });

  it('opening a run keeps the filters, and an old `#/run/<id>` link still opens it', async () => {
    goTo('/durable#?status=failed');
    render(<App />, { wrapper });
    await waitFor(() => expect(lastRunsQuery().status).toBe('failed'));

    const input = screen.getByLabelText('open run by id');
    fireEvent.change(input, { target: { value: 'r1' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(window.location.hash).toBe('#/run/r1?status=failed'));
    await screen.findByRole('heading', { name: 'shared-flow' });
    expect(chip('failed').getAttribute('aria-pressed')).toBe('true');

    expect(parseRoute('#/run/r1')).toEqual({ page: 'runs', runId: 'r1' });
    expect(parseRoute('#/run/r1?status=failed')).toEqual({ page: 'runs', runId: 'r1' });
    expect(parseRoute('#/workers?x=1')).toEqual({ page: 'workers' });
    expect(parseRoute('#?status=failed')).toEqual({ page: 'runs' });
  });

  it('leaving for Workers and coming back keeps the filters', async () => {
    goTo('/durable#?status=failed');
    render(<App />, { wrapper });
    await waitFor(() => expect(lastRunsQuery().status).toBe('failed'));

    fireEvent.click(screen.getAllByText('Workers')[0] as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#/workers'));
    fireEvent.click(screen.getAllByText('Runs')[0] as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#?status=failed'));
    expect(chip('failed').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('originParam', () => {
  it('spells the app facet `(app)` and a package as itself', () => {
    expect(originParam.serialize({ kind: 'unknown' })).toBe('(app)');
    expect(originParam.parse('(app)')).toEqual({ kind: 'unknown' });
    expect(originParam.serialize({ kind: 'origin', origin: '@acme/billing' })).toBe(
      '@acme/billing',
    );
    expect(originParam.parse('@acme/billing')).toEqual({ kind: 'origin', origin: '@acme/billing' });
  });
});

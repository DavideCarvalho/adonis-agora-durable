// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunDetail } from '../client/durable-client';

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

const getRun = vi.fn<(id: string) => Promise<RunDetail>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      run: (id: string) => getRun(id),
      runs: vi.fn().mockResolvedValue([]),
      runsPage: vi.fn().mockResolvedValue({ runs: [], meta: { page: 1, size: 100, count: 0 } }),
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

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function detail(id: string): RunDetail {
  return {
    run: {
      id,
      workflow: 'searchedFlow',
      workflowVersion: '1',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    timeline: [],
    children: [],
  };
}

function submitSearch(id: string) {
  const input = screen.getByLabelText('open run by id');
  fireEvent.change(input, { target: { value: id } });
  fireEvent.submit(input.closest('form') as HTMLFormElement);
}

describe('App: run-id search in the header (GET /runs/:id)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    getRun.mockReset();
    window.location.hash = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
    window.location.hash = '';
  });

  it("navigates to the run's detail on a hit, through the same hash mechanism a list click uses", async () => {
    getRun.mockImplementation((id) => Promise.resolve(detail(id)));
    render(<App />, { wrapper });

    submitSearch('run-hit-1');

    // The detail pane opens for the found run…
    await screen.findByRole('heading', { name: 'searchedFlow' });
    // …and the run is in the URL hash, so the hit is deep-linkable like any selection.
    expect(window.location.hash).toBe('#/run/run-hit-1');
  });

  it('says "no run with that id" on a 404 instead of navigating', async () => {
    getRun.mockRejectedValue(new Error('404 Not Found'));
    render(<App />, { wrapper });

    submitSearch('run-missing');

    await screen.findByText('no run with that id');
    expect(window.location.hash).toBe('');
    // Typing again clears the miss notice — stale errors must not outlive the input they described.
    fireEvent.change(screen.getByLabelText('open run by id'), { target: { value: 'x' } });
    await waitFor(() => expect(screen.queryByText('no run with that id')).toBeNull());
  });
});

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStatus, RunsPage } from '../client/durable-client';

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
      tag?: string | string[],
      attr?: string[],
      opts?: { namespace?: string | string[]; workflow?: string | string[]; origin?: string },
      page?: { limit?: number; offset?: number },
    ) => Promise<RunsPage>
  >();
const bulk = vi.fn<(...args: unknown[]) => Promise<{ matched: number; applied: number }>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      runsPage: (...args: Parameters<typeof runsPage>) => runsPage(...args),
      bulk: (...args: unknown[]) => bulk(...args),
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

function run(id: string, status: RunStatus = 'failed') {
  return {
    id,
    workflow: 'checkout',
    workflowVersion: '1',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Render, click the `failed` status chip, and wait for the bulk bar to appear. */
async function renderWithFailedFilter() {
  runsPage.mockResolvedValue({
    runs: [run('r-failed')],
    page: { limit: 100, offset: 0, count: 1 },
  });
  render(<App />, { wrapper });
  await waitFor(() => expect(runsPage).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'failed 0' }));
  await screen.findByRole('button', { name: 'cancel all' });
}

describe('App: status chips are a SERVER-side filter (the list and the bulk filter agree)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    runsPage.mockReset();
    bulk.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
  });

  it('sends the clicked status to /runs instead of filtering the loaded pages client-side', async () => {
    await renderWithFailedFilter();
    await waitFor(() => {
      const statuses = runsPage.mock.calls.map(([status]) => status);
      expect(statuses).toContain('failed');
    });
  });

  it('offers a `blocked` chip (first-class engine status) and no `cancelling` one (never emitted)', async () => {
    runsPage.mockResolvedValue({ runs: [], page: { limit: 100, offset: 0, count: 0 } });
    render(<App />, { wrapper });
    expect(screen.getByRole('button', { name: 'blocked 0' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cancelling 0' })).toBeNull();
  });
});

describe('App: bulk actions confirm first and report { matched, applied } after', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    runsPage.mockReset();
    bulk.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
  });

  it('opens a confirmation dialog naming the action and the current filter — nothing runs yet', async () => {
    await renderWithFailedFilter();
    fireEvent.click(screen.getByRole('button', { name: 'cancel all' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Cancel all matching runs')).toBeTruthy();
    expect(within(dialog).getByText('status failed')).toBeTruthy();
    expect(bulk).not.toHaveBeenCalled();
  });

  it('runs the action only on confirm, scoped by the same server-side filter as the list', async () => {
    bulk.mockResolvedValue({ matched: 3, applied: 3 });
    await renderWithFailedFilter();
    fireEvent.click(screen.getByRole('button', { name: 'cancel all' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'cancel all' }));

    await waitFor(() => expect(bulk).toHaveBeenCalledTimes(1));
    expect(bulk.mock.calls[0]?.[0]).toBe('cancel');
    expect(bulk.mock.calls[0]?.[1]).toMatchObject({ status: 'failed' });
    // The result toast: the server's { matched, applied }, verbatim.
    await screen.findByText(/Bulk cancel/);
    expect(screen.getByText(/Bulk cancel/).textContent).toContain('3 of 3 matched runs cancelled');
  });

  it('warns when matched hit the 500-run server cap — runs beyond it were left untouched', async () => {
    bulk.mockResolvedValue({ matched: 500, applied: 482 });
    await renderWithFailedFilter();
    fireEvent.click(screen.getByRole('button', { name: 'retry all' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'retry all' }));

    await screen.findByText(/only the first 500 were\s+affected/);
    expect(bulk.mock.calls[0]?.[0]).toBe('retry');
  });

  it('closing the dialog without confirming runs nothing', async () => {
    await renderWithFailedFilter();
    fireEvent.click(screen.getByRole('button', { name: 'retry all' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bulk).not.toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, RunDetail } from '../client/durable-client';

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
const cancel = vi.fn();
const retryWithInput = vi.fn();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      run: (id: string) => getRun(id),
      cancel: (...args: unknown[]) => cancel(...args),
      retryWithInput: (...args: unknown[]) => retryWithInput(...args),
      streamRun: () => () => {},
      runs: vi.fn().mockResolvedValue([]),
      runsPage: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, perPage: 100, currentPage: 1, lastPage: 1, firstPage: 1 },
      }),
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
const { DurableActionError } = await import('../client/durable-client');

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function detail(id: string, run: Partial<RunDetail['run']>): RunDetail {
  return {
    run: {
      id,
      workflow: 'approve',
      workflowVersion: '1',
      status: 'suspended',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...run,
    },
    timeline: [],
    children: [],
  };
}

/**
 * The run detail of a run that is waiting, or being cancelled: what it offers and how it reads must
 * come from the run itself, never from whether the run happens to be on the loaded list page.
 */
describe('App: the run detail of a waiting or cancelling run', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    getRun.mockReset();
    cancel.mockReset();
    retryWithInput.mockReset();
    window.location.hash = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
    window.location.hash = '';
  });

  it('offers Send update from the detail’s own waiting stamp, and reads awaiting, not running', async () => {
    getRun.mockImplementation((id) =>
      Promise.resolve(detail(id, { waiting: { on: 'signal', name: `update:${id}:set-limit` } })),
    );
    window.location.hash = '#/run/w1';
    render(<App />, { wrapper });
    const heading = await screen.findByRole('heading', { name: 'approve' });
    await screen.findByText('Send update');
    const header = heading.parentElement as HTMLElement;
    await waitFor(() => expect(header.textContent).toContain('awaiting'));
    expect(header.textContent).not.toContain('running');
  });

  it('shows a parked run with nothing in flight as suspended', async () => {
    getRun.mockImplementation((id) => Promise.resolve(detail(id, {})));
    window.location.hash = '#/run/p1';
    render(<App />, { wrapper });
    const heading = await screen.findByRole('heading', { name: 'approve' });
    const header = heading.parentElement as HTMLElement;
    await waitFor(() => expect(header.textContent).toContain('suspended'));
    expect(header.textContent).not.toContain('running');
  });

  it('a cancelling run with no compensation recorded yet reads Cancelling, not Saga compensated', async () => {
    getRun.mockImplementation((id) => Promise.resolve(detail(id, { status: 'cancelling' })));
    window.location.hash = '#/run/c1';
    render(<App />, { wrapper });
    await screen.findByRole('heading', { name: 'approve' });
    await screen.findByText('Cancelling');
    expect(screen.queryByText('Saga compensated')).toBeNull();
  });

  it('says so on the page when an action is refused', async () => {
    getRun.mockImplementation((id) => Promise.resolve(detail(id, {})));
    cancel.mockRejectedValue(
      new DurableActionError(
        302,
        'The server redirected this request instead of answering it',
        undefined,
      ),
    );
    window.location.hash = '#/run/x1';
    render(<App />, { wrapper });
    await screen.findByRole('heading', { name: 'approve' });
    const button = (await screen.findAllByRole('button')).find((b) => b.textContent === 'Cancel');
    expect(button).toBeDefined();
    act(() => button?.click());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('redirected');
  });

  it('says so on the page when fix-and-replay is refused', async () => {
    getRun.mockImplementation((id) => Promise.resolve(detail(id, { status: 'failed' })));
    retryWithInput.mockRejectedValue(new Error('input rejected by the server'));
    window.location.hash = '#/run/f1';
    render(<App />, { wrapper });
    await screen.findByRole('heading', { name: 'approve' });
    const open = (await screen.findAllByRole('button')).find((b) =>
      /fix/i.test(b.textContent ?? ''),
    );
    expect(open).toBeDefined();
    act(() => open?.click());
    const submit = (await screen.findAllByRole('button')).find(
      (b) => /replay/i.test(b.textContent ?? '') && b !== open,
    );
    act(() => submit?.click());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('input rejected');
  });
});

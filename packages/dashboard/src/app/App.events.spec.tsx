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
/** The fake stream: the `onEvent` the run detail handed `streamRun`, per run id. */
const streams = new Map<string, (event: EngineEvent) => void>();
const closed: string[] = [];

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      run: (id: string) => getRun(id),
      streamRun: (id: string, onEvent: (event: EngineEvent) => void) => {
        streams.set(id, onEvent);
        return () => closed.push(id);
      },
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
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    timeline: [],
    children: [],
    lifecycleSubscribers: ['strict'],
    lifecycleDeliveries: [{ subscriber: 'strict', state: 'failed' }],
  };
}

describe('App: the run detail Events panel (live stream)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    getRun.mockReset();
    streams.clear();
    closed.length = 0;
    window.location.hash = '';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
    window.location.hash = '';
  });

  it('streams a settled run and draws what arrives, filling the failed subscriber reason', async () => {
    getRun.mockImplementation((id) => Promise.resolve(detail(id)));
    window.location.hash = '#/run/i1';
    const { unmount } = render(<App />, { wrapper });

    await screen.findByRole('heading', { name: 'ingest' });
    expect(screen.getByTestId('run-events').textContent).toContain('Live only');
    await waitFor(() => expect(streams.has('i1')).toBe(true));

    act(() =>
      streams.get('i1')?.({
        type: 'run.trigger_failed',
        runId: 'i1',
        name: 'strict',
        error: { message: 'bad input' },
        at: '2026-01-01T10:00:00.000Z',
      }),
    );
    act(() =>
      streams.get('i1')?.({
        type: 'run.triggered',
        runId: 'i1',
        name: 'audit',
        triggeredRunId: 'evt:i1:completed:audit',
        at: '2026-01-01T10:00:01.000Z',
      }),
    );

    const rows = [...screen.getByTestId('run-events').querySelectorAll('li')];
    expect(rows.map((r) => r.getAttribute('data-type'))).toEqual([
      'run.triggered',
      'run.trigger_failed',
    ]);
    expect(screen.getByText('evt:i1:completed:audit')).toBeTruthy();
    expect(document.querySelector('li[data-state="failed"]')?.textContent).toContain(
      'failed: bad input',
    );

    unmount();
    expect(closed).toContain('i1');
  });
});

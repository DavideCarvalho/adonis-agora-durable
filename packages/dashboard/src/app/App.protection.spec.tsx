// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPicker, DurableTopology, RunDetail, ScheduleInfo } from '../client/durable-client';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

/** Same happy-dom layout-measurement workaround as `App.detail.spec.tsx`. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const apps = vi.fn<() => Promise<AppPicker>>();
const getRun = vi.fn<(id: string) => Promise<RunDetail>>();
const schedules = vi.fn<() => Promise<ScheduleInfo[]>>();
const topology = vi.fn<() => Promise<DurableTopology>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      apps: () => apps(),
      run: (id: string) => getRun(id),
      schedules: () => schedules(),
      streamRun: () => () => {},
      runs: vi.fn().mockResolvedValue([]),
      runsPage: vi.fn().mockResolvedValue({
        data: [],
        meta: { total: 0, perPage: 100, currentPage: 1, lastPage: 1, firstPage: 1 },
      }),
      values: vi.fn().mockResolvedValue([]),
      workers: vi.fn().mockResolvedValue([]),
      tenants: vi.fn().mockResolvedValue({ mode: 'off', all: false, selected: null, tenants: [] }),
      topology: () => topology(),
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('App: protection badges in the header', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    apps.mockReset();
    apps.mockResolvedValue({ local: { label: 'This app' }, apps: [], selected: null });
    topology.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/durable');
  });

  it("shows the served app's messages and store protection", async () => {
    topology.mockResolvedValue({
      role: 'standalone',
      protection: {
        messages: [{ transport: 'bullmq', mode: 'app-key', acceptPlain: false }],
        store: { codec: true, coverage: 'extended' },
        redact: { run: false, checkpoint: false },
      },
    });
    window.history.replaceState(null, '', '/durable#/workers');
    render(<App />, { wrapper });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="protection-badges"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="protection-messages"]')?.textContent).toBe(
      'Messages: sealed (app key)',
    );
    expect(document.querySelector('[data-testid="protection-store"]')?.textContent).toBe(
      'Store: encrypted (extended)',
    );
  });

  it('shows no badge when the server (or the picked app) sends no descriptor', async () => {
    topology.mockResolvedValue({ role: 'standalone' });
    window.history.replaceState(null, '', '/durable#/workers');
    render(<App />, { wrapper });
    await screen.findByRole('button', { name: /^App/ }).catch(() => undefined);
    await waitFor(() => expect(topology).toHaveBeenCalled());
    expect(document.querySelector('[data-testid="protection-badges"]')).toBeNull();
    expect(screen.queryByText(/Messages:/)).toBeNull();
  });
});

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPicker, RunDetail, ScheduleInfo } from '../client/durable-client';

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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function picker(actions: 'app' | 'none'): AppPicker {
  return {
    local: { label: 'Hub' },
    apps: [{ id: 'et', label: 'Entre Textos', mode: 'federated', actions }],
    selected: 'et',
  };
}

function runDetail(id: string, run: Partial<RunDetail['run']>): RunDetail {
  return {
    run: {
      id,
      workflow: 'approve',
      workflowVersion: '1',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...run,
    },
    timeline: [],
    children: [],
  };
}
const failedRun = (id: string) => runDetail(id, { status: 'failed' });

const READ_ONLY = 'Entre Textos is federated and read-only here: change it in Entre Textos itself.';

function buttonNamed(text: string): HTMLButtonElement | undefined {
  return screen.queryAllByRole('button').find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}

describe('App: a federated app picked in the App selector', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    apps.mockReset();
    getRun.mockReset();
    schedules.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/durable');
  });

  it('tags the trigger and says, on top of the page, whose data this is and who acts', async () => {
    apps.mockResolvedValue(picker('app'));
    window.history.replaceState(null, '', '/durable?app=et#/workers');
    render(<App />, { wrapper });
    const trigger = await screen.findByRole('button', { name: 'App' });
    await waitFor(() =>
      expect(trigger.querySelector('[data-app-mode="federated"]')).not.toBeNull(),
    );
    const notice = await screen.findByRole('note');
    expect(notice.textContent).toContain("reads Entre Textos's data from Entre Textos's own store");
    expect(notice.textContent).toContain(
      'Actions are sent to Entre Textos, which runs them itself',
    );
  });

  it('shows no notice for this app', async () => {
    apps.mockResolvedValue({ ...picker('none'), selected: null });
    window.history.replaceState(null, '', '/durable#/workers');
    render(<App />, { wrapper });
    await screen.findByRole('button', { name: 'App' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('keeps the run actions on when the app runs them itself', async () => {
    apps.mockResolvedValue(picker('app'));
    getRun.mockImplementation((id) => Promise.resolve(failedRun(id)));
    window.history.replaceState(null, '', '/durable?app=et#/run/r1');
    render(<App />, { wrapper });
    await screen.findByRole('heading', { name: 'approve' });
    await screen.findByRole('note');
    expect(buttonNamed('Retry')?.disabled).toBe(false);
    expect(buttonNamed('Retry')?.title).toBe('');
  });

  it('disables every run action, with the reason, when the app is browse-only here', async () => {
    apps.mockResolvedValue(picker('none'));
    getRun.mockImplementation((id) => Promise.resolve(failedRun(id)));
    window.history.replaceState(null, '', '/durable?app=et#/run/r1');
    render(<App />, { wrapper });
    await screen.findByRole('heading', { name: 'approve' });
    const notice = await screen.findByRole('note');
    expect(notice.textContent).toContain('Read-only here: change it in Entre Textos itself.');
    await waitFor(() => expect(buttonNamed('Retry')?.disabled).toBe(true));
    for (const name of ['Retry', 'Fix & replay']) {
      const button = buttonNamed(name);
      expect(button, name).toBeDefined();
      expect(button?.disabled, name).toBe(true);
      expect(button?.title, name).toBe(READ_ONLY);
    }
  });

  it('disables cancel and the wait deliveries, with the reason, when the app is browse-only here', async () => {
    apps.mockResolvedValue(picker('none'));
    getRun.mockImplementation((id) =>
      Promise.resolve(
        runDetail(id, { status: 'suspended', waiting: { on: 'signal', name: 'go' } }),
      ),
    );
    window.history.replaceState(null, '', '/durable?app=et#/run/w1');
    render(<App />, { wrapper });
    await screen.findByRole('heading', { name: 'approve' });
    await screen.findByText('Deliver signal');
    await waitFor(() => expect(buttonNamed('Deliver signal')?.disabled).toBe(true));
    expect(buttonNamed('Deliver signal')?.title).toBe(READ_ONLY);
    expect(buttonNamed('Cancel')?.disabled).toBe(true);
    expect(buttonNamed('Cancel')?.title).toBe(READ_ONLY);
  });

  it('disables schedule control, with the reason, when the app is browse-only here', async () => {
    apps.mockResolvedValue(picker('none'));
    schedules.mockResolvedValue([
      {
        key: 'nightly',
        workflow: 'report',
        cron: '0 3 * * *',
        paused: false,
        pausedAtRuntime: false,
        lastFireAt: Date.now() - 3_600_000,
        nextFireAt: Date.now() + 3_600_000,
        currentWindowRunId: 'w1',
      } as ScheduleInfo,
    ]);
    window.history.replaceState(null, '', '/durable?app=et#/schedules');
    render(<App />, { wrapper });
    await screen.findByText('nightly');
    await waitFor(() => expect(buttonNamed('Pause')?.disabled).toBe(true));
    expect(buttonNamed('Pause')?.title).toBe(READ_ONLY);
    expect(buttonNamed('Run now')?.disabled).toBe(true);
    expect(buttonNamed('Run now')?.title).toBe(READ_ONLY);
  });
});

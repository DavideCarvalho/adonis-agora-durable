// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPicker, RunDetail, ScheduleInfo, TenantPicker } from '../client/durable-client';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

/** Same happy-dom layout-measurement workaround as `App.detail.spec.tsx`. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const apps = vi.fn<() => Promise<AppPicker>>();
const tenants = vi.fn<() => Promise<TenantPicker>>();
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
      tenants: () => tenants(),
      selectTenant: vi.fn().mockResolvedValue({ tenant: 'org-2' }),
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
const { resetConsoleCache } = await import('../agora-kit/console-data');
const { CONFIG_ELEMENT_ID } = await import('../client/durable-client');
const { NuqsHashAdapter } = await import('../agora-kit/url-state/nuqs-hash-adapter');
const { useRunFilters } = await import('./runs/RunsPage');

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

function runDetail(id: string): RunDetail {
  return {
    run: {
      id,
      workflow: 'approve',
      workflowVersion: '1',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    timeline: [],
    children: [],
  };
}

/** The sidebar entry named `label` (a link in the shell's nav). */
function navLink(label: string): HTMLAnchorElement {
  const link = screen.getAllByRole('link').find((a) => a.textContent?.trim() === label) as
    | HTMLAnchorElement
    | undefined;
  if (!link) throw new Error(`no nav link ${label}`);
  return link;
}

let probed: ReturnType<typeof useRunFilters> | undefined;
/** Exposes the runs board's filter setters. */
function Probe() {
  probed = useRunFilters();
  return null;
}

describe('the picked app (`?app=`) survives in-console navigation', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    apps.mockReset();
    getRun.mockReset();
    schedules.mockReset();
    schedules.mockResolvedValue([]);
    apps.mockResolvedValue(picker('app'));
    tenants.mockReset();
    tenants.mockResolvedValue({ mode: 'off', all: false, selected: null, tenants: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/durable');
  });

  it('through the sidebar', async () => {
    window.history.replaceState(null, '', '/durable?app=et#/workers');
    render(<App />, { wrapper });
    await screen.findByRole('button', { name: /^App/ });
    fireEvent.click(navLink('Runs'));
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.search).toBe('?app=et');
    fireEvent.click(navLink('Schedules'));
    await waitFor(() => expect(window.location.hash).toBe('#/schedules'));
    expect(window.location.search).toBe('?app=et');
    fireEvent.click(navLink('Workers'));
    await waitFor(() => expect(window.location.hash).toBe('#/workers'));
    expect(window.location.search).toBe('?app=et');
  });

  it('through the ⌘K page commands', async () => {
    window.history.replaceState(null, '', '/durable?app=et#/workers');
    render(<App />, { wrapper });
    await screen.findByRole('button', { name: /^App/ });
    act(() => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    const runs = await screen.findByRole('option', { name: /^Runs/ });
    fireEvent.click(runs);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.search).toBe('?app=et');
  });

  it('through detail links (hash-only hrefs keep the page query)', async () => {
    getRun.mockResolvedValue(runDetail('r-1'));
    window.history.replaceState(null, '', '/durable?app=et#/run/r-1');
    render(<App />, { wrapper });
    const links = await waitFor(() => {
      const found = screen
        .getAllByRole('link')
        .filter((a) => a.getAttribute('href')?.startsWith('#/workflow/'));
      expect(found.length).toBeGreaterThan(0);
      return found as HTMLAnchorElement[];
    });
    for (const a of links) expect(new URL(a.href).searchParams.get('app')).toBe('et');
  });

  it('through the runs board filters (nuqs writes into the hash)', async () => {
    window.history.replaceState(null, '', '/durable?app=et');
    render(
      <NuqsHashAdapter>
        <Probe />
      </NuqsHashAdapter>,
    );
    act(() => probed?.setStatus('failed'));
    await waitFor(() => expect(window.location.hash).toContain('status=failed'));
    expect(window.location.search).toBe('?app=et');
  });

  it('into the console switcher right after an organization pick', async () => {
    resetConsoleCache();
    const block = document.createElement('script');
    block.type = 'application/json';
    block.id = CONFIG_ELEMENT_ID;
    block.textContent = JSON.stringify({ switcher: { endpoint: '/x/api/consoles', others: 1 } });
    document.head.appendChild(block);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              current: 'x',
              consoles: [
                { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
              ],
            }),
          ),
      ),
    );
    try {
      window.history.replaceState(null, '', '/durable#/workers');
      tenants.mockResolvedValue({
        mode: 'pick',
        all: true,
        selected: null,
        tenants: [
          { id: 'org-1', label: 'Acme' },
          { id: 'org-2', label: 'Globex' },
        ],
      });
      render(<App />, { wrapper });
      fireEvent.click(await screen.findByRole('button', { name: /^Organization/ }));
      fireEvent.mouseDown(await screen.findByRole('option', { name: /Globex/ }));
      await waitFor(() => expect(window.location.search).toBe('?tenant=org-2'));
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /switch console/ }));
      });
      const link = (await screen.findAllByRole('menuitem')).find((el) => el.tagName === 'A');
      await waitFor(() => expect(link?.getAttribute('href')).toBe('/telescope?tenant=org-2'));
    } finally {
      block.remove();
    }
  });
});

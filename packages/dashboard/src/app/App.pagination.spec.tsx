// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunsPage } from '../client/durable-client';

// No jest-dom in this package (see `OriginFacets.spec.tsx`) — plain DOM assertions only.

/** Same happy-dom layout-measurement workaround as `RunsList.spec.tsx` — `@tanstack/react-virtual`
 *  reads `offsetWidth`/`offsetHeight`, which happy-dom always reports as 0 with no real layout
 *  engine behind it. A fixed non-zero stub keeps the virtualizer's viewport/row-size math sane. */
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
      tag?: string,
      attr?: string[],
      opts?: { namespace?: string; origin?: string },
      page?: { page?: number; size?: number },
    ) => Promise<RunsPage>
  >();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
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

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function page(runs: RunsPage['runs'], meta: RunsPage['meta']): RunsPage {
  return { runs, meta };
}

function run(id: string, tag?: string) {
  return {
    id,
    workflow: 'checkout',
    workflowVersion: '1',
    status: 'completed' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(tag ? { tags: [tag] } : {}),
  };
}

describe('App: real pagination wiring (useInfiniteQuery over durableClient.runsPage)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    runsPage.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
  });

  it('fetches page 1 on mount (paging is 1-based, like the rest of the ecosystem)', async () => {
    runsPage.mockResolvedValue(page([run('r1')], { page: 1, size: 100, count: 1 }));
    render(<App />, { wrapper });

    await waitFor(() => expect(runsPage).toHaveBeenCalled());
    const [, , , , pageArg] = runsPage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      unknown,
      { page?: number; size?: number },
    ];
    expect(pageArg).toEqual({ page: 1, size: 100 });
  });

  it('resets to page 1 on a NEW query rather than continuing the old accumulated pages when the tag filter changes', async () => {
    runsPage.mockResolvedValue(page([run('r1')], { page: 1, size: 100, count: 1 }));
    render(<App />, { wrapper });
    await waitFor(() => expect(runsPage).toHaveBeenCalledTimes(1));

    runsPage.mockClear();
    runsPage.mockResolvedValue(page([run('r2', 'tier:pro')], { page: 1, size: 100, count: 1 }));

    // The tag filter is a value picker now: open it, type the tag, take it as typed.
    fireEvent.click(screen.getByLabelText('filter by tag'));
    fireEvent.change(screen.getByPlaceholderText('search, or type a value…'), {
      target: { value: 'tier:pro' },
    });
    fireEvent.click(await screen.findByLabelText('use tier:pro as typed'));

    await waitFor(() => expect(runsPage).toHaveBeenCalled());
    const [, tagArg, , , pageArg] = runsPage.mock.calls[0] as unknown as [
      unknown,
      string[] | undefined,
      unknown,
      unknown,
      { page?: number; size?: number },
    ];
    expect(tagArg).toEqual(['tier:pro']);
    // A fresh query for the new tag — starts at page 1, not wherever the old (untagged) query had
    // scrolled to.
    expect(pageArg.page).toBe(1);
  });

  it('requests the next page once the loaded page came back full (server\'s only "more may exist" signal)', async () => {
    // A full page (count === size) on page 1 — `hasNextPage` should flip true.
    const firstPage = Array.from({ length: 5 }, (_, i) => run(`r${i}`));
    runsPage.mockResolvedValueOnce(page(firstPage, { page: 1, size: 5, count: 5 }));
    runsPage.mockResolvedValue(page([run('r5')], { page: 2, size: 5, count: 1 }));

    render(<App />, { wrapper });
    await waitFor(() => expect(runsPage).toHaveBeenCalledTimes(1));

    // With every one of the 5 rows visible (short list, stubbed viewport), the virtualizer's
    // scroll-into-view effect (see `RunsList.spec.tsx`) should trigger `fetchNextPage` on its own.
    await waitFor(() => expect(runsPage).toHaveBeenCalledTimes(2));
    const secondCallPageArg = (
      runsPage.mock.calls[1] as unknown as [
        unknown,
        unknown,
        unknown,
        unknown,
        { page?: number; size?: number },
      ]
    )[4];
    expect(secondCallPageArg.page).toBe(2);
  });
});

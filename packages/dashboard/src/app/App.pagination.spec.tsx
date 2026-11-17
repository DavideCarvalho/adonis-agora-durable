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
      page?: { page?: number; size?: number; cursor?: boolean; after?: string },
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

/** One cursor page: `next` is the cursor of the page after it, `null` on the last one. */
function page(data: RunsPage['data'], next: string | null, after?: string): RunsPage {
  return {
    data,
    meta: {
      nextCursor: next,
      prevCursor: null,
      hasNext: next !== null,
      hasPrev: after !== undefined,
    },
  };
}

type PageArg = { page?: number; size?: number; cursor?: boolean; after?: string };

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

  it('fetches the first page by cursor on mount (no page number, no cursor yet)', async () => {
    runsPage.mockResolvedValue(page([run('r1')], null));
    render(<App />, { wrapper });

    await waitFor(() => expect(runsPage).toHaveBeenCalled());
    const [, , , , pageArg] = runsPage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      unknown,
      PageArg,
    ];
    expect(pageArg).toEqual({ cursor: true, size: 100 });
  });

  it('resets to the first page on a NEW query rather than continuing the old accumulated pages when the tag filter changes', async () => {
    runsPage.mockResolvedValue(page([run('r1')], null));
    render(<App />, { wrapper });
    await waitFor(() => expect(runsPage).toHaveBeenCalledTimes(1));

    runsPage.mockClear();
    runsPage.mockResolvedValue(page([run('r2', 'tier:pro')], null));

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
      PageArg,
    ];
    expect(tagArg).toEqual(['tier:pro']);
    // A fresh query for the new tag — starts at the top (no cursor), not wherever the old
    // (untagged) query had scrolled to.
    expect(pageArg.after).toBeUndefined();
  });

  it('requests the next page after meta.nextCursor while meta.hasNext', async () => {
    const firstPage = Array.from({ length: 5 }, (_, i) => run(`r${i}`));
    runsPage.mockResolvedValueOnce(page(firstPage, 'c1'));
    runsPage.mockResolvedValue(page([run('r5')], null, 'c1'));

    render(<App />, { wrapper });
    await waitFor(() => expect(runsPage).toHaveBeenCalledTimes(1));

    // With every one of the 5 rows visible (short list, stubbed viewport), the virtualizer's
    // scroll-into-view effect (see `RunsList.spec.tsx`) should trigger `fetchNextPage` on its own.
    await waitFor(() => expect(runsPage).toHaveBeenCalledTimes(2));
    const secondCallPageArg = (
      runsPage.mock.calls[1] as unknown as [unknown, unknown, unknown, unknown, PageArg]
    )[4];
    expect(secondCallPageArg).toMatchObject({ cursor: true, after: 'c1' });
  });

  it('stops at the last page even when it came back full', async () => {
    const full = Array.from({ length: 5 }, (_, i) => run(`r${i}`));
    runsPage.mockResolvedValue(page(full, null));

    render(<App />, { wrapper });
    await waitFor(() => expect(runsPage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runsPage).toHaveBeenCalledTimes(1);
  });
  it('a live refresh after a head insert drops no run: each page re-reads after the FRESH page before it', async () => {
    // A keyset server over a mutable list, newest first, 3 per page; the cursor is the last id.
    const list = ['r6', 'r5', 'r4', 'r3', 'r2', 'r1'];
    runsPage.mockImplementation(async (_s, _t, _a, _o, pageArg) => {
      const start = pageArg?.after ? list.indexOf(pageArg.after) + 1 : 0;
      const rows = list.slice(start, start + 3);
      const more = start + 3 < list.length;
      return page(
        rows.map((id) => run(id)),
        more ? rows[rows.length - 1]! : null,
        pageArg?.after,
      );
    });

    render(<App />, { wrapper });
    // Both pages load (the board asks for the next page while the end of the list is in view).
    await waitFor(() =>
      expect(runsPage.mock.calls.map((c) => (c[4] as PageArg).after)).toEqual([undefined, 'r4']),
    );
    const loaded = runsPage.mock.calls.length;

    // A run is created at the head: page 1 now ends at r5, and r4 slides onto page 2. A refresh
    // that re-used page 2's old `after` (r4) would show neither page with r4 in it.
    list.unshift('n7');
    await waitFor(
      () => {
        const afters = runsPage.mock.calls.slice(loaded).map((c) => (c[4] as PageArg).after);
        expect(afters).toContain('r5');
      },
      { timeout: 6000 },
    );
    const refreshAfters = runsPage.mock.calls.slice(loaded).map((c) => (c[4] as PageArg).after);
    expect(refreshAfters).not.toContain('r4');
    // Every run the board held before the insert is still on a loaded page, plus the new one; r1
    // slid past the two loaded pages and waits behind "load more" (page 2 now hands out r2).
    await waitFor(async () => {
      const read = new Set<string>();
      let last: RunsPage | undefined;
      for (const r of runsPage.mock.results.slice(loaded)) {
        last = await r.value;
        for (const row of last.data) read.add(row.id);
      }
      expect([...read].sort()).toEqual(['n7', 'r2', 'r3', 'r4', 'r5', 'r6']);
      expect(last?.meta).toMatchObject({ hasNext: true, nextCursor: 'r2' });
    });
  }, 15000);
});

// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from '../client/durable-client';
import { RunsList } from './App';

// No jest-dom in this package (see `OriginFacets.spec.tsx`): every assertion here reads a plain DOM
// property/attribute rather than a jest-dom matcher.

/** happy-dom has no real layout engine — `offsetWidth`/`offsetHeight` are always `0`, and
 *  `@tanstack/react-virtual` reads them BOTH for the scroll container's viewport size (so it never
 *  keeps the `initialRect` `RunsList` seeds it with — a synchronous measurement on mount overwrites
 *  it with the real, zeroed-out rect) AND per-row via `measureElement`. Stubbing a fixed non-zero
 *  `offsetHeight`/`offsetWidth` for every element makes both measurements deterministic, matching the
 *  approach TanStack Virtual's own test suite uses for the same reason. */
let restoreOffsetHeight: () => void;
let restoreOffsetWidth: () => void;
const FAKE_ROW_HEIGHT = 96;
const FAKE_VIEWPORT_WIDTH = 340;

function stubElementSize() {
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: FAKE_ROW_HEIGHT,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    value: FAKE_VIEWPORT_WIDTH,
  });
  restoreOffsetHeight = () =>
    heightDesc
      ? Object.defineProperty(HTMLElement.prototype, 'offsetHeight', heightDesc)
      : undefined;
  restoreOffsetWidth = () =>
    widthDesc ? Object.defineProperty(HTMLElement.prototype, 'offsetWidth', widthDesc) : undefined;
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function makeRuns(n: number): WorkflowRun[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `run-${i}`,
    workflow: 'checkout',
    workflowVersion: '1',
    status: 'completed' as const,
    createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }));
}

const emptyNotice = { message: 'No runs yet.' };

// Mirrors `App.tsx`'s (unexported) `RUN_ROW_ESTIMATE_PX` — the virtualizer's first-paint row-height
// guess before any row is actually measured.
const RUN_ROW_ESTIMATE_PX = 88;

function noop() {}

describe('<RunsList> virtualization', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
  });

  it('mounts far fewer row buttons than the total run count for a large list', () => {
    const runs = makeRuns(500);
    render(
      <RunsList
        runs={runs}
        allRuns={runs}
        health={[]}
        onSelect={noop}
        onSelectTag={noop}
        onSelectNamespace={noop}
        onSelectOrigin={noop}
        emptyNotice={emptyNotice}
      />,
    );

    // Every row is a <button> (see `RunRow`) — with 500 runs and only ~480px of seeded viewport height
    // (`RunsList`'s `initialRect`) at an ~88px row estimate, only a windowed handful should ever mount.
    const rendered = screen.getAllByRole('button').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
  });

  it("still accounts for every run's height in the scroll track, even though most never mount", () => {
    const runs = makeRuns(500);
    const { container } = render(
      <RunsList
        runs={runs}
        allRuns={runs}
        health={[]}
        onSelect={noop}
        onSelectTag={noop}
        onSelectNamespace={noop}
        onSelectOrigin={noop}
        emptyNotice={emptyNotice}
      />,
    );
    const list = container.querySelector('ul');
    const heightMatch = list?.getAttribute('style')?.match(/height:\s*([\d.]+)px/);
    const totalHeight = heightMatch ? Number(heightMatch[1]) : 0;
    // The scroll track is sized for the FULL 500-row list (well beyond what the handful of mounted
    // rows alone would add up to) — proof the virtualizer windows RENDERING, not the scrollable range.
    expect(totalHeight).toBeGreaterThan(400 * RUN_ROW_ESTIMATE_PX);
  });

  it('shows the skeleton instead of an empty virtualized list while the first fetch is in flight', () => {
    render(
      <RunsList
        runs={[]}
        allRuns={[]}
        health={[]}
        loading
        onSelect={noop}
        onSelectTag={noop}
        onSelectNamespace={noop}
        onSelectOrigin={noop}
        emptyNotice={emptyNotice}
      />,
    );
    // The skeleton renders its placeholder rows as an `aria-hidden` <ul>; the real empty-state text
    // must NOT be shown while a fetch is still pending.
    expect(screen.queryByText('No runs yet.')).toBeNull();
  });
});

describe('<RunsList> infinite-scroll pagination', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
  });

  it('asks for the next page once every loaded run is scrolled into view and more may exist', async () => {
    // A short list (well under the seeded ~480px viewport) so every row is visible on first paint —
    // deterministic without needing to simulate a real scroll gesture in happy-dom.
    const runs = makeRuns(3);
    const onLoadMore = vi.fn();
    render(
      <RunsList
        runs={runs}
        allRuns={runs}
        health={[]}
        onSelect={noop}
        onSelectTag={noop}
        onSelectNamespace={noop}
        onSelectOrigin={noop}
        emptyNotice={emptyNotice}
        hasMore
        loadingMore={false}
        onLoadMore={onLoadMore}
      />,
    );

    await waitFor(() => expect(onLoadMore).toHaveBeenCalled());
  });

  it('does NOT ask for more once the server has signalled there is no next page', async () => {
    const runs = makeRuns(3);
    const onLoadMore = vi.fn();
    render(
      <RunsList
        runs={runs}
        allRuns={runs}
        health={[]}
        onSelect={noop}
        onSelectTag={noop}
        onSelectNamespace={noop}
        onSelectOrigin={noop}
        emptyNotice={emptyNotice}
        hasMore={false}
        loadingMore={false}
        onLoadMore={onLoadMore}
      />,
    );

    // Give any (incorrect) effect a chance to fire before asserting the negative.
    await new Promise((r) => setTimeout(r, 0));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('does not re-request while a page fetch triggered by scroll is already in flight', async () => {
    const runs = makeRuns(3);
    const onLoadMore = vi.fn();
    render(
      <RunsList
        runs={runs}
        allRuns={runs}
        health={[]}
        onSelect={noop}
        onSelectTag={noop}
        onSelectNamespace={noop}
        onSelectOrigin={noop}
        emptyNotice={emptyNotice}
        hasMore
        loadingMore
        onLoadMore={onLoadMore}
      />,
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('shows a "loading more" footer while the next page is being fetched', () => {
    const runs = makeRuns(3);
    render(
      <RunsList
        runs={runs}
        allRuns={runs}
        health={[]}
        onSelect={noop}
        onSelectTag={noop}
        onSelectNamespace={noop}
        onSelectOrigin={noop}
        emptyNotice={emptyNotice}
        hasMore
        loadingMore
        onLoadMore={noop}
      />,
    );

    expect(screen.getByText('loading more…')).toBeTruthy();
  });
});

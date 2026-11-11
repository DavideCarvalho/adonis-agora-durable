// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let total = 1;
const values = vi.fn(async () => [{ value: 'running', count: total }]);

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      streamRun: () => () => {},
      runs: vi.fn().mockResolvedValue([]),
      runsPage: vi.fn().mockResolvedValue({ runs: [], meta: { page: 1, size: 100, count: 0 } }),
      values: () => values(),
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

const { App } = await import('./App');

/** The ALL chip's count, read off the chip itself. */
function allCount(): string | undefined {
  const chip = screen
    .getAllByRole('button')
    .find((b) => b.textContent?.toLowerCase().startsWith('all'));
  return chip?.textContent?.replace(/^all/i, '');
}

describe('App: the status chip counts follow the list', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    stubElementSize();
    window.location.hash = '';
    total = 1;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreOffsetHeight();
    restoreOffsetWidth();
  });

  it('recounts ALL whenever the run list refreshes', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    render(<App />, { wrapper });
    await waitFor(() => expect(allCount()).toBe('1'));
    total = 3;
    await act(() => qc.invalidateQueries({ queryKey: ['runs'] }));
    await waitFor(() => expect(allCount()).toBe('3'));
  });
});

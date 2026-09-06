// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { durableClient } from '../client/durable-client';
import { ValuePicker } from './ValuePicker';

// No jest-dom in this package (see `OriginFacets.spec.tsx`): every assertion reads plain DOM.

function renderPicker(props: Partial<Parameters<typeof ValuePicker>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ValuePicker
        field="tag"
        scope={{}}
        value={[]}
        onChange={() => {}}
        label="filter by tag"
        placeholder="filter by tag…"
        {...props}
      />
    </QueryClientProvider>,
  );
}

function page(size: number, prefix = 'tag'): { value: string; count: number }[] {
  return Array.from({ length: size }, (_, i) => ({ value: `${prefix}-${i}`, count: size - i }));
}

describe('<ValuePicker>', () => {
  // Restored here rather than at the end of each case: a case that FAILS never reaches its own
  // cleanup, and fake timers left installed stall every async test after it.
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks the SERVER to search, rather than filtering the page it happens to hold', async () => {
    // The list is bounded, so the values an operator searches for are routinely the ones the bound
    // cut. A client-side filter can only ever find what already arrived.
    vi.useFakeTimers();
    const values = vi.spyOn(durableClient, 'values').mockResolvedValue([]);
    renderPicker();

    fireEvent.click(screen.getByLabelText('filter by tag'));
    fireEvent.change(screen.getByPlaceholderText('search, or type a value…'), {
      target: { value: 'type:' },
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(values).toHaveBeenCalledWith('tag', {}, expect.objectContaining({ search: 'type:' }));
  });

  it('debounces typing into one request instead of one per keystroke', async () => {
    vi.useFakeTimers();
    const values = vi.spyOn(durableClient, 'values').mockResolvedValue([]);
    renderPicker();
    fireEvent.click(screen.getByLabelText('filter by tag'));
    const box = screen.getByPlaceholderText('search, or type a value…');

    for (const text of ['t', 'ty', 'typ', 'type']) {
      fireEvent.change(box, { target: { value: text } });
    }
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // The first (empty) request is the unsearched list; what must not multiply is the searching.
    const searched = values.mock.calls.filter((call) => (call[2]?.search ?? '') !== '');
    expect(searched).toHaveLength(1);
    expect(searched[0]?.[2]?.search).toBe('type');
  });

  it('asks for the next page when the list is scrolled to its end, and appends it', async () => {
    const first = page(50);
    const second = page(3, 'more');
    const values = vi
      .spyOn(durableClient, 'values')
      .mockImplementation(async (_field, _scope, opts) =>
        (opts?.offset ?? 0) === 0 ? first : second,
      );
    renderPicker();

    fireEvent.click(screen.getByLabelText('filter by tag'));
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));

    fireEvent.scroll(screen.getByRole('listbox'));

    // The offset is what was already loaded, not a page number — so a short page cannot desync it.
    await waitFor(() =>
      expect(values).toHaveBeenCalledWith('tag', {}, expect.objectContaining({ offset: 50 })),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('option').some((o) => o.textContent?.includes('more-0'))).toBe(
        true,
      ),
    );
  });

  it('stops asking once a short page says there is no more', async () => {
    const values = vi.spyOn(durableClient, 'values').mockResolvedValue(page(2));
    renderPicker();

    fireEvent.click(screen.getByLabelText('filter by tag'));
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
    values.mockClear();
    fireEvent.scroll(screen.getByRole('listbox'));

    expect(values).not.toHaveBeenCalled();
  });
});

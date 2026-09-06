// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { durableClient } from '../client/durable-client';
import { AttributeFilters } from './AttributeFilters';

// No jest-dom in this package (see `OriginFacets.spec.tsx`): every assertion reads plain DOM.

function renderFilters(props: Partial<Parameters<typeof AttributeFilters>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AttributeFilters value={[]} onChange={() => {}} scope={{}} {...props} />
    </QueryClientProvider>,
  );
}

describe('<AttributeFilters>', () => {
  it('reads as a filter, not as an "add" affordance', async () => {
    // It used to be a small dashed chip next to two controls that look like filter boxes, so it read
    // as an empty decoration — the reason a real operator reported "attribute is empty" without ever
    // opening it.
    renderFilters();

    const trigger = screen.getByLabelText('filter by search attribute');
    expect(trigger.textContent).toContain('filter by attribute…');
  });

  it('asks the server for the keys these runs carry when it opens', async () => {
    const values = vi.spyOn(durableClient, 'values').mockResolvedValue([
      { value: 'baseId', count: 12 },
      { value: 'kind', count: 12 },
    ]);
    renderFilters({ scope: { namespace: ['acme'] } });

    fireEvent.click(screen.getByLabelText('filter by search attribute'));

    // Scoped by the rest of the filter, like the other pickers — and asked for as a PAGE, since the
    // key list is bounded and searched on the server.
    await waitFor(() =>
      expect(values).toHaveBeenCalledWith(
        'attr',
        { namespace: ['acme'] },
        expect.objectContaining({ limit: expect.any(Number), offset: 0 }),
      ),
    );
  });

  it('shows the predicates it currently holds', () => {
    renderFilters({ value: ['tier:in:pro|enterprise'] });

    expect(screen.getByLabelText('filter by search attribute').textContent).toContain(
      'tier is any of pro, enterprise',
    );
  });

  it('clears every predicate in one action', () => {
    const onChange = vi.fn();
    renderFilters({ value: ['tier:eq:pro'], onChange });

    fireEvent.click(screen.getByLabelText('clear attribute filters'));

    expect(onChange).toHaveBeenCalledWith([]);
  });
});

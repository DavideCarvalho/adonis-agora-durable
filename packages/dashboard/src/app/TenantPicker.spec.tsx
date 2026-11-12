// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantPicker } from '../client/durable-client';

const tenants = vi.fn<() => Promise<TenantPicker>>();
const selectTenant = vi.fn<(id: string) => Promise<{ tenant: string }>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      tenants: () => tenants(),
      selectTenant: (id: string) => selectTenant(id),
    },
  };
});

const { TenantPickerControl } = await import('./TenantPicker');
const { withTenant } = await import('../client/durable-client');

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/durable');
  tenants.mockReset();
  selectTenant.mockReset();
});

describe('TenantPickerControl', () => {
  it('renders nothing with tenancy off', async () => {
    tenants.mockResolvedValue({ mode: 'off', all: false, selected: null, tenants: [] });
    const { container } = render(<TenantPickerControl />, { wrapper });
    await waitFor(() => expect(tenants).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('shows a fixed chip for one organization', async () => {
    tenants.mockResolvedValue({
      mode: 'fixed',
      all: false,
      selected: null,
      tenants: [{ id: 'org-1', label: 'Acme' }],
    });
    render(<TenantPickerControl />, { wrapper });
    expect(await screen.findByText('Acme')).toBeTruthy();
    expect(document.querySelector('[data-tenant-picker="fixed"]')).not.toBeNull();
  });

  it('says "none" for a viewer with no organization', async () => {
    tenants.mockResolvedValue({ mode: 'none', all: false, selected: null, tenants: [] });
    render(<TenantPickerControl />, { wrapper });
    expect(await screen.findByText('none')).toBeTruthy();
  });

  it('lists "All organizations" first, filters, and records a pick in the URL', async () => {
    tenants.mockResolvedValue({
      mode: 'pick',
      all: true,
      selected: null,
      tenants: [
        { id: 'org-1', label: 'Acme' },
        { id: 'org-2', label: 'Globex' },
      ],
    });
    selectTenant.mockResolvedValue({ tenant: 'org-2' });
    render(<TenantPickerControl />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'Organization' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'All organizations',
      'Acmeorg-1',
      'Globexorg-2',
    ]);
    fireEvent.change(screen.getByRole('textbox', { name: 'search organizations' }), {
      target: { value: 'glo' },
    });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All organizations',
      'Globexorg-2',
    ]);
    fireEvent.click(screen.getByText('Globex'));
    await waitFor(() => expect(selectTenant).toHaveBeenCalledWith('org-2'));
    await waitFor(() => expect(window.location.search).toBe('?tenant=org-2'));
    expect(withTenant('/runs?page=1')).toBe('/runs?page=1&tenant=org-2');
    expect(withTenant('/topology')).toBe('/topology?tenant=org-2');
  });
});

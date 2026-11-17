// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppPicker } from '../client/durable-client';

const apps = vi.fn<() => Promise<AppPicker>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return { ...actual, durableClient: { ...actual.durableClient, apps: () => apps() } };
});

const { AppPickerControl } = await import('./AppPicker');
const { withScope } = await import('../client/durable-client');

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/durable');
  apps.mockReset();
});

describe('AppPickerControl', () => {
  it('renders nothing when the console shows only this app', async () => {
    apps.mockResolvedValue({ local: { label: 'Hub' }, apps: [], selected: null });
    const { container } = render(<AppPickerControl />, { wrapper });
    await waitFor(() => expect(apps).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('puts the picked app in the URL, drops the open run, and scopes every API call', async () => {
    apps.mockResolvedValue({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
      selected: null,
    });
    window.history.replaceState(null, '', '/durable#/run/r-1?status=failed');
    render(<AppPickerControl />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'App' }));
    fireEvent.click(await screen.findByRole('option', { name: /Entre Textos/ }));
    await waitFor(() => expect(window.location.search).toBe('?app=entre-textos'));
    expect(window.location.hash).toBe('');
    expect(withScope('/runs?page=1')).toBe('/runs?page=1&app=entre-textos');

    // Back to this app: the parameter goes away.
    fireEvent.click(await screen.findByRole('button', { name: 'App' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Hub' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(withScope('/runs')).toBe('/runs');
  });

  it('keeps the page when it is not a run', async () => {
    apps.mockResolvedValue({
      local: { label: 'Hub' },
      apps: [{ id: 'eduliberta', label: 'EduLiberta' }],
      selected: null,
    });
    window.history.replaceState(null, '', '/durable#/workers');
    render(<AppPickerControl />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: 'App' }));
    fireEvent.click(await screen.findByRole('option', { name: /EduLiberta/ }));
    await waitFor(() => expect(window.location.search).toBe('?app=eduliberta'));
    expect(window.location.hash).toBe('#/workers');
  });
});

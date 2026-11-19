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
    fireEvent.click(await screen.findByRole('button', { name: /^App/ }));
    fireEvent.mouseDown(await screen.findByRole('option', { name: /Entre Textos/ }));
    await waitFor(() => expect(window.location.search).toBe('?app=entre-textos'));
    expect(window.location.hash).toBe('');
    expect(withScope('/runs?page=1')).toBe('/runs?page=1&app=entre-textos');

    // Back to this app: the parameter goes away.
    fireEvent.click(await screen.findByRole('button', { name: /^App/ }));
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'Hub' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(withScope('/runs')).toBe('/runs');
  });

  it('opens a searchable listbox, hints federated apps, and badges a picked federated app', async () => {
    apps.mockResolvedValue({
      local: { label: 'Hub' },
      apps: [
        { id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'none' },
        { id: 'old', label: 'Older server' },
      ],
      selected: null,
    });
    render(<AppPickerControl />, { wrapper });
    const trigger = await screen.findByRole('button', { name: /^App/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.textContent).toContain('Hub');
    // The trigger shows this app: no badge.
    expect(document.querySelector('[data-app-mode]')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Hub',
      'Entre Textosfederated',
      'Older serverold',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Search apps' }), {
      target: { value: 'entre' },
    });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Entre Textosfederated',
    ]);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Entre Textos/ }));
    await waitFor(() => expect(window.location.search).toBe('?app=entre-textos'));
    // The picked federated app is badged next to the picker, and the trigger shows it.
    const badge = await waitFor(() => {
      const el = document.querySelector('[data-app-mode="federated"]');
      expect(el).not.toBeNull();
      return el;
    });
    expect(badge?.getAttribute('title')).toContain('Read-only here');
    expect(screen.getByRole('button', { name: /^App/ }).textContent).toContain('Entre Textos');
  });

  it('keeps the page when it is not a run', async () => {
    apps.mockResolvedValue({
      local: { label: 'Hub' },
      apps: [{ id: 'eduliberta', label: 'EduLiberta' }],
      selected: null,
    });
    window.history.replaceState(null, '', '/durable#/workers');
    render(<AppPickerControl />, { wrapper });
    fireEvent.click(await screen.findByRole('button', { name: /^App/ }));
    fireEvent.mouseDown(await screen.findByRole('option', { name: /EduLiberta/ }));
    await waitFor(() => expect(window.location.search).toBe('?app=eduliberta'));
    expect(window.location.hash).toBe('#/workers');
  });
});

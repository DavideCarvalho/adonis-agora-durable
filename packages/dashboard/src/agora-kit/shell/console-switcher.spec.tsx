// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConsoleCache } from '../console-data';
import { parseShellConfig, readShellConfig } from '../shell-config';
import { ThemeProvider } from '../theme';
import { ConsoleSearch, useSearchShortcut } from './console-search';
import { ConsoleSwitcher } from './console-switcher';
import { UserFooter } from './user-footer';

const config = { endpoint: '/durable/api/consoles', others: 3 };
const brand = <span>durable brand</span>;
const current = { title: 'Workflows', package: '@adonis-agora/durable', icon: 'workflow' as const };

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetConsoleCache();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const consoles = {
  version: 1,
  current: 'durable',
  consoles: [
    {
      id: 'telescope',
      title: 'Telescope',
      package: '@adonis-agora/telescope',
      icon: 'telescope',
      href: '/telescope',
    },
    { id: 'payments', title: 'Payments', icon: 'payments', href: '/payments' },
    { id: 'odd', title: 'Odd', icon: 'nope', href: '/odd' },
    { id: 'evil', title: 'Evil', icon: 'generic', href: '//evil.example' },
    { id: 'evil2', title: 'Evil 2', icon: 'generic', href: 'javascript:alert(1)' },
  ],
};

async function openMenu() {
  const button = await screen.findByRole('button', { name: /switch console/ });
  await act(async () => {
    fireEvent.click(button);
  });
  return { button, menu: await screen.findByRole('menu') };
}

describe('ConsoleSwitcher', () => {
  it('renders the plain brand and makes no request without config', () => {
    render(<ConsoleSwitcher brand={brand} current={current} config={undefined} />);
    expect(screen.getByText('durable brand')).toBeTruthy();
    expect(document.querySelector('[data-agora-switcher]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays a plain brand when the list is empty or the request fails', async () => {
    fetchMock.mockReturnValue(respond({ version: 1, current: 'durable', consoles: [] }));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-agora-switcher]')).toBeNull();
    cleanup();
    resetConsoleCache();
    fetchMock.mockReturnValue(respond({ error: 'forbidden' }, 403));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(document.querySelector('[data-agora-switcher]')).toBeNull();
  });

  it('lists the current console first (not a link), then the others; drops unsafe hrefs', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    expect(await screen.findByText('durable brand')).toBeTruthy();
    const { button } = await openMenu();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitem');
    expect(items[0]?.tagName).not.toBe('A');
    expect(items[0]?.getAttribute('aria-current')).toBe('page');
    expect(items[0]?.textContent).toContain('Workflows');
    const links = items.filter((el) => el.tagName === 'A');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/telescope', '/payments', '/odd']);
    expect(links[0]?.textContent).toContain('@adonis-agora/telescope');
    // An unknown icon renders the generic one.
    expect(links[2]?.querySelector('svg')?.getAttribute('data-icon')).toBe('generic');
  });

  it('closes on Escape', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    render(<ConsoleSwitcher brand={brand} current={current} config={config} />);
    const { menu } = await openMenu();
    await act(async () => {
      fireEvent.keyDown(menu, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('offers "Search all consoles" when given onSearch', async () => {
    fetchMock.mockReturnValue(respond(consoles));
    const onSearch = vi.fn();
    render(<ConsoleSwitcher brand={brand} current={current} config={config} onSearch={onSearch} />);
    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getByText('Search all consoles'));
    });
    expect(onSearch).toHaveBeenCalled();
  });
});

function SearchHarness() {
  const [open, setOpen] = useState(false);
  useSearchShortcut(true, setOpen);
  return (
    <ConsoleSearch
      config={{ endpoint: '/durable/api/consoles/search' }}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

describe('ConsoleSearch', () => {
  it('Cmd-K opens it, searches every console and groups the hits (unsafe hrefs dropped)', async () => {
    fetchMock.mockImplementation(() =>
      respond({
        version: 1,
        q: 'ord',
        results: [
          {
            id: 'payments',
            title: 'Payments',
            icon: 'payments',
            hits: [
              { title: 'pi_123', subtitle: 'paid', href: '/payments#/p/pi_123' },
              { title: 'bad', href: 'https://evil.example' },
            ],
          },
        ],
      }),
    );
    render(<SearchHarness />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true });
    });
    const input = await screen.findByRole('combobox', { name: 'Search all consoles' });
    fireEvent.change(input, { target: { value: 'ord' } });
    await waitFor(() => expect(screen.getByText('pi_123')).toBeTruthy(), { timeout: 2000 });
    expect(fetchMock).toHaveBeenCalledWith(
      '/durable/api/consoles/search?q=ord',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(screen.queryByText('bad')).toBeNull();
    expect(screen.getByText('Payments')).toBeTruthy();
  });

  it('also reads authkit-style `{ groups }` answers', async () => {
    fetchMock.mockImplementation(() =>
      respond({
        groups: [
          {
            id: 'authkit',
            title: 'Identity',
            icon: 'identity',
            hits: [{ title: 'ann@x.test', href: '/admin?view=users' }],
          },
        ],
      }),
    );
    render(<SearchHarness />);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search all consoles' }), {
      target: { value: 'ann' },
    });
    await waitFor(() => expect(screen.getByText('ann@x.test')).toBeTruthy(), { timeout: 2000 });
  });
});

describe('UserFooter', () => {
  it('shows the viewer, and signs out with a POST form carrying the CSRF token', () => {
    render(
      <ThemeProvider storageKey="test-theme">
        <UserFooter
          viewer={{ label: 'Ann Lee', email: 'ann@x.test', role: 'admin' }}
          signOut={{ action: '/account/logout', csrfToken: 'tok' }}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('Ann Lee')).toBeTruthy();
    expect(screen.getByText('AL')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Sign out' });
    expect(submit.getAttribute('type')).toBe('submit');
    const form = submit.closest('form');
    expect(form?.getAttribute('action')).toBe('/account/logout');
    expect(form?.getAttribute('method')).toBe('post');
    expect(form?.querySelector<HTMLInputElement>('input[name="_csrf"]')?.value).toBe('tok');
  });

  it('renders a sign-out link, and no user row without a viewer', () => {
    render(
      <ThemeProvider storageKey="test-theme">
        <UserFooter signOut={{ href: '/logout' }} />
      </ThemeProvider>,
    );
    expect(document.querySelector('[data-agora-viewer]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign out' }).getAttribute('href')).toBe('/logout');
  });

  it('toggles the theme on <html> and remembers it', () => {
    render(
      <ThemeProvider storageKey="test-theme">
        <UserFooter />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('test-theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });
});

describe('shell config (the data block)', () => {
  function block(json: string) {
    document.body.innerHTML = `<script type="application/json" id="cfg">${json}</script>`;
  }

  it('reads switcher, search, viewer and sign-out', () => {
    block(
      JSON.stringify({
        base: '/durable',
        switcher: { endpoint: '/durable/api/consoles', others: 2 },
        search: { endpoint: '/durable/api/consoles/search' },
        viewer: { label: 'Ann', email: 'ann@x.test', role: 'admin' },
        signOut: { action: '/account/logout', csrfToken: 't' },
      }),
    );
    expect(readShellConfig('cfg')).toEqual({
      switcher: { endpoint: '/durable/api/consoles', others: 2 },
      search: { endpoint: '/durable/api/consoles/search' },
      viewer: { label: 'Ann', email: 'ann@x.test', role: 'admin' },
      signOut: { action: '/account/logout', csrfToken: 't' },
    });
  });

  it('derives the search endpoint from the switcher for older servers', () => {
    expect(
      parseShellConfig({ switcher: { endpoint: '/p/api/consoles', others: 1 } }).search,
    ).toEqual({
      endpoint: '/p/api/consoles/search',
    });
  });

  it('ignores absent, empty or unsafe fields', () => {
    block('{"base":"/durable"}');
    expect(readShellConfig('cfg')).toEqual({});
    expect(parseShellConfig({ switcher: { endpoint: '/x', others: 0 } }).switcher).toBeUndefined();
    expect(
      parseShellConfig({ switcher: { endpoint: '//evil.example/x', others: 2 } }).switcher,
    ).toBeUndefined();
    expect(
      parseShellConfig({ signOut: { action: 'https://evil.example/out' } }).signOut,
    ).toBeUndefined();
    expect(parseShellConfig({ signOut: { href: '/\\evil' } }).signOut).toBeUndefined();
    expect(parseShellConfig({ viewer: { label: '' } }).viewer).toBeUndefined();
    block('not json');
    expect(readShellConfig('cfg')).toEqual({});
  });
});

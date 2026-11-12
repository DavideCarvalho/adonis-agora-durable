import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGORA_CONSOLES_BINDING,
  type AgoraConsoleEntry,
  type AgoraConsoleRegistry,
  durableConsoleSearch,
  listVisibleConsoles,
  otherConsoles,
  registerAgoraConsole,
  searchConsoles,
} from '../../src/dashboard/console_switcher.js';
import { renderIndexHtml } from '../../src/dashboard/spa.js';

function fakeContainer() {
  const values = new Map<string, unknown>();
  return {
    values,
    hasBinding: (key: string) => values.has(key),
    bindValue: (key: string, value: unknown) => void values.set(key, value),
    make: async (key: string) => values.get(key),
  };
}

const allow = async () => ({ allowed: true });
const deny = async () => ({ allowed: false, reason: 'forbidden' });

function entry(over: Partial<AgoraConsoleEntry> & { id: string }): AgoraConsoleEntry {
  return {
    title: over.id,
    icon: 'generic',
    path: `/${over.id}`,
    order: 50,
    authorize: allow,
    ...over,
  };
}

const ctx = {} as HttpContext;

describe('registerAgoraConsole', () => {
  it('creates the registry when absent and reuses it when present', async () => {
    const container = fakeContainer();
    expect(await registerAgoraConsole(container, entry({ id: 'durable' }))).toBe(true);
    // A second lib's copy of the helper appends to the same value.
    expect(await registerAgoraConsole(container, entry({ id: 'payments' }))).toBe(true);
    const registry = container.values.get(AGORA_CONSOLES_BINDING) as AgoraConsoleRegistry;
    expect(registry.version).toBe(1);
    expect(registry.entries.map((e) => e.id)).toEqual(['durable', 'payments']);
  });

  it('skips a registry of another version', async () => {
    const container = fakeContainer();
    container.bindValue(AGORA_CONSOLES_BINDING, { version: 2, entries: [] });
    expect(await registerAgoraConsole(container, entry({ id: 'durable' }))).toBe(false);
  });

  it('warns on a duplicate id', async () => {
    const container = fakeContainer();
    const warn = vi.fn();
    await registerAgoraConsole(container, entry({ id: 'durable' }), { warn });
    expect(await registerAgoraConsole(container, entry({ id: 'durable' }), { warn })).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"durable" already registered'));
  });

  it('rejects a bad id or path', async () => {
    const container = fakeContainer();
    await expect(registerAgoraConsole(container, entry({ id: 'Bad Id' }))).rejects.toThrow();
    await expect(
      registerAgoraConsole(container, entry({ id: 'x', path: '//evil.example' })),
    ).rejects.toThrow();
    await expect(
      registerAgoraConsole(container, entry({ id: 'y', path: 'https://evil.example' })),
    ).rejects.toThrow();
  });
});

describe('listVisibleConsoles', () => {
  it('lists the allowed others, sorted, without self, never a reason', async () => {
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [
        entry({ id: 'durable', order: 10 }),
        entry({ id: 'media', order: 50, icon: 'media' }),
        entry({ id: 'payments', order: 40, authorize: deny }),
        entry({ id: 'telescope', order: 20, package: '@adonis-agora/telescope' }),
        entry({
          id: 'agent',
          order: 30,
          authorize: async () => ({ allowed: false, redirectTo: '/login' }),
        }),
        entry({ id: 'odd', order: 60, icon: 'weird' as never }),
        entry({ id: 'broken', order: 70, authorize: async () => Promise.reject(new Error('x')) }),
      ],
    };
    const out = await listVisibleConsoles(registry, 'durable', ctx);
    expect(out).toEqual({
      version: 1,
      current: 'durable',
      consoles: [
        {
          id: 'telescope',
          title: 'telescope',
          package: '@adonis-agora/telescope',
          icon: 'generic',
          href: '/telescope',
        },
        { id: 'media', title: 'media', icon: 'media', href: '/media' },
        { id: 'odd', title: 'odd', icon: 'generic', href: '/odd' },
      ],
    });
  });

  it('runs the gates in parallel and hides a slow one after 300 ms', async () => {
    vi.useFakeTimers();
    try {
      const slow = () =>
        new Promise<{ allowed: boolean }>((r) => setTimeout(() => r({ allowed: true }), 1000));
      const fine = () =>
        new Promise<{ allowed: boolean }>((r) => setTimeout(() => r({ allowed: true }), 200));
      const registry: AgoraConsoleRegistry = {
        version: 1,
        entries: [
          entry({ id: 'a', authorize: fine }),
          entry({ id: 'b', authorize: fine }),
          entry({ id: 'c', authorize: slow }),
        ],
      };
      const pending = listVisibleConsoles(registry, 'self', ctx);
      await vi.advanceTimersByTimeAsync(301);
      const out = await pending;
      // a + b each take 200 ms: run one after the other they would miss the 300 ms total.
      expect(out.consoles.map((c) => c.id)).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks ctx as a probe while the others decide', async () => {
    const seen: unknown[] = [];
    const probeCtx = {} as HttpContext & { agoraProbe?: boolean };
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [
        entry({
          id: 'x',
          authorize: async (c) => {
            seen.push((c as typeof probeCtx).agoraProbe);
            return { allowed: true };
          },
        }),
      ],
    };
    await listVisibleConsoles(registry, 'self', probeCtx);
    expect(seen).toEqual([true]);
    expect(probeCtx.agoraProbe).toBeUndefined();
  });

  it('is empty without a registry', async () => {
    expect((await listVisibleConsoles(undefined, 'durable', ctx)).consoles).toEqual([]);
    expect(otherConsoles(undefined, 'durable')).toBe(0);
  });
});

describe('searchConsoles', () => {
  it('searches self and the allowed others, 5 safe hits each', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `p${i}`, href: `/payments#${i}` }));
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [
        entry({
          id: 'durable',
          order: 10,
          search: async () => [{ title: 'run-1', href: '/durable#/run/run-1' }],
        }),
        entry({ id: 'payments', order: 40, search: async () => many }),
        entry({
          id: 'media',
          order: 50,
          authorize: deny,
          search: async () => [{ title: 'm', href: '/m' }],
        }),
        entry({
          id: 'evil',
          order: 60,
          search: async () => [
            { title: 'x', href: 'https://evil.example' },
            { title: 'y', href: '//evil.example' },
          ],
        }),
        entry({ id: 'nosearch', order: 70 }),
      ],
    };
    const out = await searchConsoles(registry, 'durable', ctx, '  run  ');
    expect(out.q).toBe('run');
    expect(out.results.map((r) => r.id)).toEqual(['durable', 'payments']);
    expect(out.results[1]?.hits).toHaveLength(5);
  });

  it('answers nothing for a blank query', async () => {
    const registry: AgoraConsoleRegistry = {
      version: 1,
      entries: [entry({ id: 'a', search: async () => [{ title: 't', href: '/t' }] })],
    };
    expect((await searchConsoles(registry, 'a', ctx, '   ')).results).toEqual([]);
  });
});

describe('durableConsoleSearch', () => {
  it('finds a run by id and workflows by name', async () => {
    const search = durableConsoleSearch(
      async () => ({
        getRun: async (id) =>
          id === 'r 1' ? { id: 'r 1', workflow: 'ship', status: 'failed' } : null,
        workflows: async () => [
          { value: 'ship', count: 3 },
          { value: null, count: 1 },
          { value: 'shipment', count: 1 },
        ],
      }),
      '/durable',
    );
    expect(await search(ctx, 'r 1', 5)).toEqual([
      { title: 'r 1', subtitle: 'run · ship · failed', href: '/durable#/run/r%201' },
      { title: 'ship', subtitle: 'workflow · 3 runs', href: '/durable#/workflow/ship' },
      { title: 'shipment', subtitle: 'workflow · 1 run', href: '/durable#/workflow/shipment' },
    ]);
  });

  it('uses / for a root mount', async () => {
    const search = durableConsoleSearch(
      async () => ({
        getRun: async () => ({ id: 'a', workflow: 'w', status: 'completed' }),
        workflows: async () => [],
      }),
      '',
    );
    expect((await search(ctx, 'a', 5))[0]?.href).toBe('/#/run/a');
  });
});

describe('renderIndexHtml switcher field', () => {
  const read = (html: string) =>
    JSON.parse(
      /<script type="application\/json" id="durable-dashboard-config">(.*?)<\/script>/.exec(
        html,
      )?.[1] ?? '{}',
    );

  it('adds the field only when other consoles exist', () => {
    const html = '<html><head></head><body></body></html>';
    expect(read(renderIndexHtml(html, '/durable', '/durable/api')).switcher).toBeUndefined();
    expect(
      read(
        renderIndexHtml(html, '/durable', '/durable/api', {
          switcher: { endpoint: '/durable/api/consoles', others: 0 },
        }),
      ).switcher,
    ).toBeUndefined();
    expect(
      read(
        renderIndexHtml(html, '/durable', '/durable/api', {
          switcher: { endpoint: '/durable/api/consoles', others: 2 },
        }),
      ).switcher,
    ).toEqual({ endpoint: '/durable/api/consoles', others: 2 });
  });
});

describe('DashboardProvider — console switcher routes', () => {
  let appRoot: string;
  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-switcher-'));
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  async function boot(dashboard: Record<string, unknown>, withOther: boolean) {
    class OtherConsoleProvider {
      constructor(protected app: { container: ReturnType<typeof fakeContainer> }) {}
      async boot() {
        await registerAgoraConsole(
          this.app.container,
          entry({ id: 'payments', title: 'Payments', icon: 'payments', order: 40 }),
        );
      }
    }
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        config: { durable_dashboard: dashboard },
        rcFileContents: {
          providers: [
            ...(withOther ? [async () => ({ default: OtherConsoleProvider })] : []),
            () => import('../../providers/dashboard_provider.js'),
          ],
        },
      })
      .create(pathToFileURL(`${appRoot}/`));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    return app;
  }

  it('registers the console and mounts the routes', async () => {
    const app = await boot({ authorize: () => true }, true);
    const registry = (await app.container.make(AGORA_CONSOLES_BINDING)) as AgoraConsoleRegistry;
    expect(registry.entries.map((e) => [e.id, e.path, e.title])).toEqual([
      ['payments', '/payments', 'Payments'],
      ['durable', '/durable', 'Workflows'],
    ]);
    const router = await app.container.make('router');
    router.commit();
    const names = router.toJSON().root?.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['durable_dashboard.consoles', 'durable_dashboard.consoles.search']),
    );
  });

  /** Serve the booted app over a real HTTP server and GET `path`. */
  async function get(
    app: Awaited<ReturnType<typeof boot>>,
    path: string,
  ): Promise<{ status: number; body: unknown; cacheControl: string | null }> {
    const server = await app.container.make('server');
    await server.boot();
    const http = createServer((req, res) => server.handle(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = http.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return {
        status: res.status,
        body: await res.json(),
        cacheControl: res.headers.get('cache-control'),
      };
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  }

  it('answers the visible consoles behind the console guard', async () => {
    const app = await boot({ authorize: () => true }, true);
    const res = await get(app, '/durable/api/consoles');
    expect(res.status).toBe(200);
    expect(res.cacheControl).toBe('private, no-store');
    expect(res.body).toEqual({
      version: 1,
      current: 'durable',
      consoles: [{ id: 'payments', title: 'Payments', icon: 'payments', href: '/payments' }],
    });
    const search = await get(app, '/durable/api/consoles/search?q=nothing-matches');
    expect(search.status).toBe(200);
    expect(search.body).toEqual({ version: 1, q: 'nothing-matches', results: [] });
  });

  it('refuses a viewer the console refuses, without the list', async () => {
    const forbidden = await get(
      await boot({ authorize: () => false }, true),
      '/durable/api/consoles',
    );
    expect(forbidden).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    const unauth = await get(
      await boot({ authorize: () => ({ redirectTo: '/login' }) }, true),
      '/durable/api/consoles/search?q=x',
    );
    expect(unauth).toMatchObject({
      status: 401,
      body: { error: 'unauthenticated', redirectTo: '/login' },
    });
  });

  it('does not register a disabled console', async () => {
    const app = await boot({ enabled: false }, true);
    const registry = (await app.container.make(AGORA_CONSOLES_BINDING)) as AgoraConsoleRegistry;
    expect(registry.entries.map((e) => e.id)).toEqual(['payments']);
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appScopedDashboardEngine,
  grantedApps,
  narrowToApps,
} from '../../src/dashboard/app_scope.js';
import { anyAuthorize } from '../../src/dashboard/console_authorize.js';
import { normalizeConsoleDecision } from '../../src/dashboard/console_decision.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

describe('the `apps` grant', () => {
  it('normalizeConsoleDecision keeps an apps grant, like every Agora console', () => {
    expect(normalizeConsoleDecision({ allowed: true, apps: '*' })).toEqual({
      allowed: true,
      apps: '*',
    });
    expect(normalizeConsoleDecision({ allowed: true, apps: ['acme', 3, ''] })).toEqual({
      allowed: true,
      apps: ['acme', '3'],
    });
    // A malformed grant narrows to none (fail closed), never to every app.
    expect(normalizeConsoleDecision({ allowed: true, apps: 'acme' })).toEqual({
      allowed: true,
      apps: [],
    });
  });

  it('anyAuthorize keeps the apps grant of the authorizer that allows', async () => {
    const ctx = {} as HttpContext;
    const gate = anyAuthorize(
      () => false,
      () => ({ allowed: true as const, apps: ['acme'], tenants: '*' as const }),
    );
    expect(await gate(ctx)).toEqual({ allowed: true, apps: ['acme'], tenants: '*' });
    // An allow with no grant still means every app.
    expect(await anyAuthorize(() => true)(ctx)).toEqual({ allowed: true });
  });

  it("'*' and an omitted grant confine nothing", () => {
    expect(grantedApps('*')).toBeUndefined();
    expect(grantedApps(undefined)).toBeUndefined();
    expect(grantedApps(['acme'])).toEqual(['acme']);
  });

  it("narrows a query's namespace filter to the granted apps", () => {
    expect(narrowToApps({}, ['acme', 'globex'])).toEqual({ namespaces: ['acme', 'globex'] });
    expect(narrowToApps({ namespace: 'acme' }, ['acme'])).toEqual({ namespaces: ['acme'] });
    expect(narrowToApps({ namespace: 'initech' }, ['acme'])).toEqual({ namespaces: [] });
    expect(narrowToApps({ namespaces: ['acme', 'initech'] }, ['acme', 'globex'])).toEqual({
      namespaces: ['acme'],
    });
  });
});

describe('appScopedDashboardEngine', () => {
  async function seeded() {
    const raw = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    raw.observeAllNamespaces();
    raw.register('greet', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'hi';
    });
    await raw.start('greet', {}, 'a', { namespace: 'acme' });
    await raw.start('greet', {}, 'g', { namespace: 'globex' });
    await raw.start('greet', {}, 'own');
    return raw;
  }

  it("confines listings, counts and reads to the granted apps, and refuses another app's actions", async () => {
    const raw = await seeded();
    const engine = appScopedDashboardEngine(storeDashboardEngine(raw), ['acme']);
    expect((await engine.listRuns({})).map((r) => r.id)).toEqual(['a']);
    expect(await engine.countRuns?.({})).toBe(1);
    // A filter naming another app is answered with nothing, not widened.
    expect(await engine.listRuns({ namespace: 'globex' })).toEqual([]);
    expect(await engine.getRun('g')).toBeNull();
    expect(await engine.getRun('own')).toBeNull();
    expect(await engine.cancel('g')).toBeNull();
    expect((await raw.getRun('g'))?.status).not.toBe('cancelled');
    expect(await engine.getRun('a')).not.toBeNull();
  });

  it("keeps only the app's worker groups and schedules", async () => {
    const base = storeDashboardEngine(
      new WorkflowEngine({ store: new InMemoryStateStore(), transport: new InMemoryTransport() }),
    );
    let triggered = 0;
    const engine = appScopedDashboardEngine(
      {
        ...base,
        workerHealth: async () => [
          { group: 'charge@acme', depth: 0, liveWorkers: [] },
          { group: 'charge@globex', depth: 0, liveWorkers: [] },
          { group: 'charge', depth: 0, liveWorkers: [] },
        ],
        listSchedules: async () =>
          [
            { key: 'nightly-acme', namespace: 'acme' },
            { key: 'nightly-globex', namespace: 'globex' },
            { key: 'unpinned' },
          ] as never,
        triggerSchedule: async () => {
          triggered += 1;
          return null;
        },
      },
      ['acme'],
    );
    expect((await engine.workerHealth()).map((g) => g.group)).toEqual(['charge@acme']);
    expect((await engine.listSchedules?.())?.map((s) => s.key)).toEqual(['nightly-acme']);
    await engine.triggerSchedule?.('nightly-globex');
    expect(triggered).toBe(0);
    await engine.triggerSchedule?.('nightly-acme');
    expect(triggered).toBe(1);
  });
});

describe('the console over HTTP with an apps grant', () => {
  let appRoot: string;
  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-apps-'));
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  async function boot(authorize: (ctx: HttpContext) => unknown) {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        config: { durable: {}, durable_dashboard: { authorize } },
        rcFileContents: {
          providers: [
            () => import('../../providers/durable_provider.js'),
            () => import('../../providers/dashboard_provider.js'),
          ],
        },
      })
      .create(pathToFileURL(`${appRoot}/`));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    const engine = await app.container.make(WorkflowEngine);
    engine.register('greet', '1', async () => 'hi');
    await engine.start('greet', {}, 'a', { namespace: 'acme' });
    await engine.start('greet', {}, 'g', { namespace: 'globex' });
    return app;
  }

  async function get(app: Awaited<ReturnType<typeof boot>>, path: string) {
    const server = await app.container.make('server');
    await server.boot();
    const http = createServer((req, res) => server.handle(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = http.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
      await new Promise((resolve) => http.close(resolve));
    }
  }
  const ids = (body: Record<string, unknown>) =>
    (body.data as Array<{ id: string }>).map((r) => r.id).sort();

  it("a viewer granted `apps: ['acme']` sees and reads only acme's runs", async () => {
    const app = await boot(() => ({ allowed: true, apps: ['acme'] }));
    expect(ids((await get(app, '/durable/api/runs')).body)).toEqual(['a']);
    expect((await get(app, '/durable/api/runs/g')).status).toBe(404);
    expect((await get(app, '/durable/api/runs/a')).status).toBe(200);
    await app.terminate();
  });

  it("`apps: '*'` sees every app", async () => {
    const app = await boot(() => ({ allowed: true, apps: '*' }));
    expect(ids((await get(app, '/durable/api/runs')).body)).toEqual(['a', 'g']);
    await app.terminate();
  });
});

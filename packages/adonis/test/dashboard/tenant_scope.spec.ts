import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeConsoleDecision } from '../../src/dashboard/console_authorize.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import {
  resolveConsoleTenantScope,
  scopedDashboardEngine,
} from '../../src/dashboard/tenant_scope.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

describe('resolveConsoleTenantScope', () => {
  const own = { id: 'acme', kind: 'organization', slug: 'acme-inc' };

  it("defaults to the viewer's own tenant", () => {
    expect(
      resolveConsoleTenantScope({ granted: undefined, own, selected: undefined }),
    ).toMatchObject({ authorized: ['acme'], ids: ['acme'], forged: false });
  });

  it('a viewer with no tenant sees nothing (not a 403)', () => {
    expect(
      resolveConsoleTenantScope({ granted: undefined, own: undefined, selected: undefined }),
    ).toMatchObject({ authorized: 'none', ids: [], forged: false });
  });

  it("'*' sees everything, and may narrow to one tenant", () => {
    expect(
      resolveConsoleTenantScope({ granted: '*', own, selected: undefined }).ids,
    ).toBeUndefined();
    expect(resolveConsoleTenantScope({ granted: '*', own, selected: '*' }).ids).toBeUndefined();
    expect(resolveConsoleTenantScope({ granted: '*', own, selected: 'globex' }).ids).toEqual([
      'globex',
    ]);
  });

  it('a pick outside the grant is answered with nothing and flagged', () => {
    expect(
      resolveConsoleTenantScope({ granted: ['acme', 'initech'], own, selected: 'globex' }),
    ).toMatchObject({ ids: [], forged: true });
    expect(
      resolveConsoleTenantScope({ granted: ['acme', 'initech'], own, selected: 'initech' }),
    ).toMatchObject({ ids: ['initech'], forged: false });
    expect(
      resolveConsoleTenantScope({ granted: ['acme', 'initech'], own, selected: undefined }).ids,
    ).toEqual(['acme', 'initech']);
  });

  it('normalizeConsoleDecision keeps a tenants grant', () => {
    expect(normalizeConsoleDecision({ allowed: true, tenants: '*' })).toEqual({
      allowed: true,
      tenants: '*',
    });
    expect(normalizeConsoleDecision({ allowed: true, tenants: ['a', 1, ''] })).toEqual({
      allowed: true,
      tenants: ['a'],
    });
    expect(normalizeConsoleDecision(true)).toEqual({ allowed: true });
  });
});

describe('scopedDashboardEngine', () => {
  async function seeded() {
    const raw = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    raw.register('greet', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'hi';
    });
    await raw.start('greet', {}, 'a', { tenantId: 'acme' });
    await raw.start('greet', {}, 'g', { tenantId: 'globex' });
    await raw.start('greet', {}, 'n');
    await expect.poll(async () => (await raw.getRun('g'))?.status).toBe('suspended');
    return raw;
  }

  it('confines listings and reads, and refuses actions outside the scope', async () => {
    const raw = await seeded();
    const engine = scopedDashboardEngine(storeDashboardEngine(raw), ['acme', null]);
    expect((await engine.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'n']);
    expect(await engine.getRun('g')).toBeNull();
    expect(await engine.cancel('g')).toBeNull();
    expect(await engine.requeue('g')).toBeNull();
    expect((await raw.getRun('g'))?.status).toBe('suspended');
    expect(await engine.getRunDetail?.('g')).toBeNull();
    expect(await engine.listCheckpoints('g')).toEqual([]);
  });

  it('no scope = no confinement', async () => {
    const raw = await seeded();
    const engine = scopedDashboardEngine(storeDashboardEngine(raw), undefined);
    expect((await engine.listRuns({})).length).toBe(3);
  });
});

// ── over HTTP, with a stand-in context tenancy slot ────────────────────────────────────────────────

type Store = { tenant?: { id: string; kind: string; slug?: string }; all?: boolean };
const als = new AsyncLocalStorage<Store>();
const SLOT = Symbol.for('@agora/context:tenancy');
const slot = {
  version: 1,
  tenancy: () => ({ enabled: true }),
  tenantFilter: () => {
    const store = als.getStore();
    if (!store) return { mode: 'system' };
    if (store.all) return { mode: 'all' };
    return store.tenant
      ? { mode: 'tenant', tenant: { ...store.tenant, source: 'app' } }
      : { mode: 'tenantless' };
  },
  withTenant: <T>(input: { id: string; kind: string } | null, fn: () => T): T =>
    als.run(input ? { tenant: input } : {}, fn),
  allTenants: <T>(fn: () => T): T => als.run({ all: true }, fn),
  tenantLabels: async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, id.toUpperCase()])),
};

describe('the console over HTTP with tenancy on', () => {
  let appRoot: string;
  const audits: string[] = [];
  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-tenancy-'));
    (globalThis as Record<symbol, unknown>)[SLOT] = slot;
    audits.length = 0;
  });
  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[SLOT];
    await rm(appRoot, { recursive: true, force: true });
  });

  async function boot(authorize: (ctx: HttpContext) => unknown) {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        config: {
          durable: {},
          durable_dashboard: {
            authorize,
            audit: (entry: { method: string; path: string }) =>
              audits.push(`${entry.method} ${entry.path}`),
          },
        },
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
    await engine.start('greet', {}, 'a', { tenantId: 'acme', tenantKind: 'organization' });
    await engine.start('greet', {}, 'g', { tenantId: 'globex', tenantKind: 'organization' });
    await engine.start('greet', {}, 'n');
    return app;
  }

  /** GET `path` as a viewer whose app request carries `tenant` (the app's own middleware sets it). */
  async function get(app: Awaited<ReturnType<typeof boot>>, path: string, tenant?: string) {
    const server = await app.container.make('server');
    await server.boot();
    const http = createServer((req, res) =>
      als.run(
        tenant ? { tenant: { id: tenant, kind: 'organization', slug: `${tenant}-slug` } } : {},
        () => server.handle(req, res),
      ),
    );
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
    (body.runs as Array<{ id: string }>).map((r) => r.id).sort();

  it("a viewer sees their own organization's runs only", async () => {
    const app = await boot(() => true);
    const res = await get(app, '/durable/api/runs', 'acme');
    expect(ids(res.body)).toEqual(['a']);
    expect((res.body.runs as Array<{ tenantId?: string }>)[0]?.tenantId).toBe('acme');
    expect((await get(app, '/durable/api/runs/g', 'acme')).status).toBe(404);
    const picker = await get(app, '/durable/api/tenants', 'acme');
    expect(picker.body).toEqual({
      mode: 'fixed',
      all: false,
      selected: null,
      tenants: [{ id: 'acme', label: 'ACME' }],
    });
  });

  it('a viewer with no organization gets an empty console, not a 403', async () => {
    const app = await boot(() => true);
    const res = await get(app, '/durable/api/runs');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([]);
    expect((await get(app, '/durable/api/tenants')).body.mode).toBe('none');
  });

  it("tenants: '*' sees every organization and may narrow", async () => {
    const app = await boot(() => ({ allowed: true, tenants: '*' }));
    expect(ids((await get(app, '/durable/api/runs', 'acme')).body)).toEqual(['a', 'g', 'n']);
    expect(ids((await get(app, '/durable/api/runs?tenant=globex', 'acme')).body)).toEqual(['g']);
    const picker = await get(app, '/durable/api/tenants', 'acme');
    expect(picker.body).toMatchObject({ mode: 'pick', all: true });
    expect((picker.body.tenants as Array<{ id: string }>).map((t) => t.id).sort()).toEqual([
      'acme',
      'globex',
    ]);
  });

  it('a forged ?tenant= outside the grant answers nothing and is audited', async () => {
    const app = await boot(() => true);
    const res = await get(app, '/durable/api/runs?tenant=globex', 'acme');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([]);
    expect(audits.some((line) => line.startsWith('TENANT') && line.includes('tenant=globex'))).toBe(
      true,
    );
  });
});

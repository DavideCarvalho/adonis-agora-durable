import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Container } from '@adonisjs/core/container';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';

/**
 * Regression test for a real crash: `@adonisjs/core/services/router` is a plain module-level
 * binding assigned only once inside `await app.booted(async () => { router = ... })` (see the
 * service's own source) — it is NOT a lazy proxy. Every provider `boot()` method runs BEFORE those
 * "booted" hooks fire, so a provider that calls `router.get(...)` synchronously inside its own
 * `boot()` crashes with "Cannot read properties of undefined (reading 'get')" — for every
 * entrypoint (`serve`, `ace`, tests) that registers it.
 *
 * This drives a REAL AdonisJS application (via `@adonisjs/core`'s own `IgnitorFactory`, the same
 * harness AdonisJS's `AceFactory` uses) through a real `register -> boot -> "booted" hooks`
 * lifecycle, with the real `@adonisjs/core/services/router` module in play, so it actually exercises
 * the ordering bug instead of a hand-rolled stand-in that can't reproduce it.
 */
describe('DashboardProvider — boots inside a real AdonisJS app', () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-dashboard-boot-'));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it('registers its routes without crashing app.boot()', async () => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: {
          // A bare loader function, exactly how a real adonisrc.ts lists a package provider.
          providers: [() => import('../providers/dashboard_provider.js')],
        },
      })
      .create(pathToFileURL(`${appRoot}/`));

    const app = ignitor.createApp('web');
    await app.init();

    // This is the crash site: DashboardProvider#boot() used to call `router.get(...)` directly,
    // and `router` (the module-level binding) is `undefined` at this point in the real lifecycle.
    await expect(app.boot()).resolves.toBeUndefined();

    // Not just "didn't throw" — prove the routes actually made it onto the router before the app
    // is considered booted (registering them any later, e.g. in a provider `ready()` hook, would be
    // too late: the HTTP server commits the router before providers' `ready()` runs).
    const router = await app.container.make('router');
    router.commit();
    // `toJSON()` is keyed by domain; the dashboard registers no domain, so its routes land under `root`.
    const routeNames = router.toJSON().root!.map((route) => route.name);

    expect(routeNames).toEqual(
      expect.arrayContaining([
        'durable_dashboard.index',
        'durable_dashboard.runs.index',
        'durable_dashboard.runs.show',
        'durable_dashboard.runs.retry',
        'durable_dashboard.runs.cancel',
        'durable_dashboard.health',
        'durable_dashboard.compat',
        'durable_dashboard.metrics',
        'durable_dashboard.runs.event',
        'durable_dashboard.webhooks.deliver',
      ]),
    );

    // The update route is plural, matching the Aviary dashboard API, and has no singular alias.
    const routes = router.toJSON().root!;
    const update = routes.find((route) => route.name === 'durable_dashboard.runs.update');
    expect(update?.pattern).toMatch(/\/api\/runs\/:id\/updates\/:name$/);
    expect(routes.some((route) => /\/runs\/:id\/update\/:name$/.test(route.pattern))).toBe(false);
  });
});

describe('DashboardProvider — boot warning when authorize is omitted', () => {
  let appRoot: string;
  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-dashboard-warn-'));
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  async function bootWith(config: Record<string, unknown> | undefined): Promise<string[]> {
    const warnings: string[] = [];
    // Runs before the dashboard provider boots: capture every logger.warn line.
    class SpyProvider {
      constructor(protected app: { container: { make(key: string): Promise<unknown> } }) {}
      async boot() {
        const logger = (await this.app.container.make('logger')) as {
          warn: (message: string) => void;
        };
        logger.warn = (message: string) => {
          warnings.push(message);
        };
      }
    }
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        ...(config ? { config: { durable_dashboard: config } } : {}),
        rcFileContents: {
          providers: [
            async () => ({ default: SpyProvider }),
            () => import('../providers/dashboard_provider.js'),
          ],
        },
      })
      .create(pathToFileURL(`${appRoot}/`));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    return warnings;
  }

  it('logs the shared warning exactly once at boot', async () => {
    const { NO_AUTHORIZE_WARNING } = await import('../src/dashboard/define_config.js');
    const warnings = await bootWith(undefined);
    expect(warnings.filter((w) => w === NO_AUTHORIZE_WARNING)).toHaveLength(1);
  });

  it('stays quiet when authorize is set', async () => {
    const { NO_AUTHORIZE_WARNING } = await import('../src/dashboard/define_config.js');
    const warnings = await bootWith({ authorize: () => true });
    expect(warnings).not.toContain(NO_AUTHORIZE_WARNING);
  });
});

describe('DashboardProvider — a mounted console observes every namespace', () => {
  let appRoot: string;
  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-dashboard-observe-'));
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it('asks the engine’s control plane to observe all namespaces once booted', async () => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        rcFileContents: { providers: [() => import('../providers/dashboard_provider.js')] },
      })
      .create(pathToFileURL(`${appRoot}/`));
    const app = ignitor.createApp('web');
    await app.init();
    let observed = 0;
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      namespace: 'default',
      controlPlane: {
        publishControl: async () => {},
        onControl: () => {},
        observeAll: () => {
          observed += 1;
        },
      },
    });
    app.container.singleton(WorkflowEngine, () => engine);
    await app.boot();
    expect(observed).toBe(1);
  });
});

describe('DashboardProvider — authorize hook owns its denial response', () => {
  /** Minimal HttpContext double: just the response surface `enforce` touches. */
  function fakeCtx() {
    const state = { status: 0, body: undefined as unknown, headers: new Map<string, string>() };
    const response = {
      getHeader: (name: string) => state.headers.get(name.toLowerCase()),
      status(code: number) {
        state.status = code;
        return response;
      },
      json(body: unknown) {
        state.body = body;
        return response;
      },
      header(name: string, value: string) {
        state.headers.set(name.toLowerCase(), value);
        return response;
      },
      send(body: unknown) {
        state.body = body;
      },
      redirect(path?: string) {
        const go = (to: string) => {
          state.status = 302;
          state.headers.set('location', to);
        };
        if (path !== undefined) return go(path);
        const builder = { withQs: () => builder, toPath: go };
        return builder;
      },
    };
    const request = {
      plainCookie: () => undefined,
      url: () => '/durable',
      // enforce() now also classifies the method (cross-site guard) — a GET is the neutral case.
      method: () => 'GET',
      header: () => undefined,
    };
    return { ctx: { response, request } as never, state };
  }

  async function runEnforce(
    authorize: (ctx: unknown) => unknown,
    mode: 'page' | 'api' = 'page',
    extra: Record<string, unknown> = {},
  ) {
    const { default: DashboardProvider } = await import('../providers/dashboard_provider.js');
    const { resolveConfig } = await import('../src/dashboard/define_config.js');
    const provider = new DashboardProvider({} as never);
    const config = resolveConfig({ authorize: authorize as never, ...extra });
    const { ctx, state } = fakeCtx();
    (ctx as { containerResolver: unknown }).containerResolver = new Container().createResolver();
    // `enforce` is TS-private (compile-time only) — reached via index access on purpose.
    const allowed = await (
      provider as unknown as {
        enforce(c: unknown, x: unknown, m: 'page' | 'api'): Promise<boolean>;
      }
    ).enforce(config, ctx, mode);
    return { allowed, state };
  }

  it('a hook that redirects to the host login keeps its 302 (no 403 overwrite)', async () => {
    const { allowed, state } = await runEnforce((ctx) => {
      (ctx as { response: { redirect(p: string): void } }).response.redirect('/login');
      return false;
    });
    expect(allowed).toBe(false);
    expect(state.status).toBe(302);
    expect(state.headers.get('location')).toBe('/login');
    expect(state.body).toBeUndefined(); // the uniform 403 body was NOT written over it
  });

  it('a hook that just returns false gets the uniform 403 JSON on an API request', async () => {
    const { allowed, state } = await runEnforce(() => false, 'api');
    expect(allowed).toBe(false);
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: 'forbidden' });
  });

  it('a hook that just returns false gets the access-denied PAGE on a page request', async () => {
    const { allowed, state } = await runEnforce(() => false, 'page');
    expect(allowed).toBe(false);
    expect(state.status).toBe(403);
    expect(state.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(state.headers.get('cache-control')).toBe('no-store, must-revalidate');
    expect(state.body).toContain('<!doctype html>');
    expect(state.body).toContain('<h1>Access denied</h1>');
    expect(state.body).toContain('Durable');
  });

  it('the page honours the accessDenied options and renderer', async () => {
    const tweaked = await runEnforce(() => false, 'page', {
      accessDenied: { title: 'Sem acesso', homeHref: '/admin' },
    });
    expect(tweaked.state.body).toContain('<h1>Sem acesso</h1>');
    expect(tweaked.state.body).toContain('href="/admin"');

    const custom = await runEnforce(() => false, 'page', {
      accessDenied: (info: { status: number }) => `<p>custom ${info.status}</p>`,
    });
    expect(custom.state.body).toBe('<p>custom 403</p>');

    const redirected = await runEnforce(() => false, 'page', {
      accessDenied: (_info: unknown, ctx: { response: { redirect(p: string): void } }) => {
        ctx.response.redirect('/entrar');
      },
    });
    expect(redirected.state.status).toBe(302);
    expect(redirected.state.headers.get('location')).toBe('/entrar');
    expect(redirected.state.body).toBeUndefined();
  });

  describe('decision contract (boolean | { allowed, reason })', () => {
    const modes = ['page', 'api'] as const;

    for (const mode of modes) {
      it(`${mode}: { allowed: false } DENIES with 403 (a truthy object is not a pass)`, async () => {
        const { allowed, state } = await runEnforce(() => ({ allowed: false }), mode);
        expect(allowed).toBe(false);
        expect(state.status).toBe(403);
        if (mode === 'api') expect(state.body).toEqual({ error: 'forbidden' });
        else expect(state.body).toContain('<h1>Access denied</h1>');
      });

      it(`${mode}: async { allowed: false } DENIES with 403`, async () => {
        const { allowed, state } = await runEnforce(async () => ({ allowed: false }), mode);
        expect(allowed).toBe(false);
        expect(state.status).toBe(403);
      });

      it(`${mode}: reason 'unauthenticated' -> 401`, async () => {
        const { allowed, state } = await runEnforce(
          () => ({ allowed: false, reason: 'unauthenticated' }),
          mode,
        );
        expect(allowed).toBe(false);
        expect(state.status).toBe(401);
        if (mode === 'api') expect(state.body).toEqual({ error: 'unauthenticated' });
        else expect(state.body).toContain('<h1>Sign in required</h1>');
      });

      it(`${mode}: reason 'forbidden' -> 403`, async () => {
        const { allowed, state } = await runEnforce(
          () => ({ allowed: false, reason: 'forbidden' }),
          mode,
        );
        expect(allowed).toBe(false);
        expect(state.status).toBe(403);
        if (mode === 'api') expect(state.body).toEqual({ error: 'forbidden' });
        else expect(state.body).toContain('<h1>Access denied</h1>');
      });

      it(`${mode}: bare false -> 403`, async () => {
        const { allowed, state } = await runEnforce(() => false, mode);
        expect(allowed).toBe(false);
        expect(state.status).toBe(403);
      });

      it(`${mode}: true and { allowed: true } pass`, async () => {
        for (const result of [true, { allowed: true }, Promise.resolve({ allowed: true })]) {
          const { allowed, state } = await runEnforce(() => result, mode);
          expect(allowed).toBe(true);
          expect(state.status).toBe(0);
          expect(state.body).toBeUndefined();
        }
      });

      it(`${mode}: a throwing hook -> 403 (never a pass, never a 500)`, async () => {
        const sync = await runEnforce(() => {
          throw new Error('boom');
        }, mode);
        expect(sync.allowed).toBe(false);
        expect(sync.state.status).toBe(403);
        const rejected = await runEnforce(() => Promise.reject(new Error('boom')), mode);
        expect(rejected.allowed).toBe(false);
        expect(rejected.state.status).toBe(403);
      });

      it(`${mode}: a hook redirect still wins over a decision object`, async () => {
        const { allowed, state } = await runEnforce((ctx) => {
          (ctx as { response: { redirect(p: string): void } }).response.redirect('/login');
          return { allowed: false, reason: 'unauthenticated' };
        }, mode);
        expect(allowed).toBe(false);
        expect(state.status).toBe(302);
        expect(state.headers.get('location')).toBe('/login');
        expect(state.body).toBeUndefined();
      });
    }

    it('non-boolean truthy junk denies (only true / allowed === true pass)', async () => {
      for (const result of ['yes', 1, {}, { allowed: 'true' }, null, undefined]) {
        const { allowed, state } = await runEnforce(() => result, 'api');
        expect(allowed).toBe(false);
        expect(state.status).toBe(403);
      }
    });
  });

  describe('console authorize contract (function | class | lazy import, redirectTo)', () => {
    class Allow {
      authorize() {
        return true;
      }
    }
    class Forbid {
      authorize() {
        return { allowed: false } as const;
      }
    }

    it('page: { redirectTo } -> 302 to that path', async () => {
      const { allowed, state } = await runEnforce(() => ({ redirectTo: '/login' }), 'page');
      expect(allowed).toBe(false);
      expect(state.status).toBe(302);
      expect(state.headers.get('location')).toBe('/login');
      expect(state.body).toBeUndefined();
    });

    it('api: { redirectTo } -> 401 JSON', async () => {
      const { allowed, state } = await runEnforce(() => ({ redirectTo: '/login' }), 'api');
      expect(allowed).toBe(false);
      expect(state.status).toBe(401);
      expect(state.body).toEqual({ error: 'unauthenticated', redirectTo: '/login' });
    });

    it('a class authorizer gates the request', async () => {
      const ok = await runEnforce(Allow as never, 'api');
      expect(ok.allowed).toBe(true);
      const denied = await runEnforce(Forbid as never, 'api');
      expect(denied.allowed).toBe(false);
      expect(denied.state.status).toBe(403);
    });

    it('a lazy import of an authorizer class gates the request', async () => {
      const ok = await runEnforce(async () => ({ default: Allow }), 'page');
      expect(ok.allowed).toBe(true);
      const denied = await runEnforce(async () => ({ default: Forbid }), 'page');
      expect(denied.allowed).toBe(false);
      expect(denied.state.status).toBe(403);
      expect(denied.state.body).toContain('<h1>Access denied</h1>');
    });
  });

  describe('default (authorize omitted): open outside production, 403 in production', () => {
    async function runDefault(inProduction: boolean | undefined, mode: 'page' | 'api' = 'api') {
      const { default: DashboardProvider } = await import('../providers/dashboard_provider.js');
      const { resolveConfig } = await import('../src/dashboard/define_config.js');
      const provider = new DashboardProvider({} as never);
      const config = resolveConfig({}, inProduction === undefined ? {} : { inProduction });
      const { ctx, state } = fakeCtx();
      const allowed = await (
        provider as unknown as {
          enforce(c: unknown, x: unknown, m: 'page' | 'api'): Promise<boolean>;
        }
      ).enforce(config, ctx, mode);
      return { allowed, state };
    }

    it('outside production every request passes', async () => {
      expect((await runDefault(false, 'api')).allowed).toBe(true);
      expect((await runDefault(false, 'page')).allowed).toBe(true);
    });

    it('in production every request is a 403 (shell and API)', async () => {
      const api = await runDefault(true, 'api');
      expect(api.allowed).toBe(false);
      expect(api.state.status).toBe(403);
      expect(api.state.body).toEqual({ error: 'forbidden' });
      const page = await runDefault(true, 'page');
      expect(page.allowed).toBe(false);
      expect(page.state.status).toBe(403);
      expect(page.state.body).toContain('<h1>Access denied</h1>');
    });

    it('an unknown environment is treated as production', async () => {
      expect((await runDefault(undefined)).allowed).toBe(false);
    });

    it('a bearer token alone opens nothing (no token default anymore)', async () => {
      const { default: DashboardProvider } = await import('../providers/dashboard_provider.js');
      const { resolveConfig } = await import('../src/dashboard/define_config.js');
      const provider = new DashboardProvider({} as never);
      const config = resolveConfig({}, { inProduction: true });
      const { ctx, state } = fakeCtx();
      (ctx as { request: { header: (n: string) => string | undefined } }).request.header = (n) =>
        n.toLowerCase() === 'authorization' ? 'Bearer sekret' : undefined;
      const allowed = await (
        provider as unknown as {
          enforce(c: unknown, x: unknown, m: 'page' | 'api'): Promise<boolean>;
        }
      ).enforce(config, ctx, 'api');
      expect(allowed).toBe(false);
      expect(state.status).toBe(403);
    });
  });

  it('authorizeByToken: a matching bearer passes, anything else is a 401', async () => {
    const { authorizeByToken } = await import('../src/dashboard/console_authorize.js');
    const gate = authorizeByToken({ token: 'sekret' });
    const withHeader = async (value: string | undefined) => {
      const { default: DashboardProvider } = await import('../providers/dashboard_provider.js');
      const { resolveConfig } = await import('../src/dashboard/define_config.js');
      const provider = new DashboardProvider({} as never);
      const config = resolveConfig({ authorize: gate }, { inProduction: true });
      const { ctx, state } = fakeCtx();
      (ctx as { request: { header: (n: string) => string | undefined } }).request.header = (n) =>
        n.toLowerCase() === 'authorization' ? value : undefined;
      const allowed = await (
        provider as unknown as {
          enforce(c: unknown, x: unknown, m: 'page' | 'api'): Promise<boolean>;
        }
      ).enforce(config, ctx, 'api');
      return { allowed, state };
    };
    expect((await withHeader('Bearer sekret')).allowed).toBe(true);
    const wrong = await withHeader('Bearer nope');
    expect(wrong.allowed).toBe(false);
    expect(wrong.state.status).toBe(401);
    expect(wrong.state.body).toEqual({ error: 'unauthenticated' });
    expect((await withHeader(undefined)).state.status).toBe(401);
  });
});

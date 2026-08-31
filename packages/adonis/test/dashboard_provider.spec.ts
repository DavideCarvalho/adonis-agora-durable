import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      ]),
    );
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
      redirect: (path: string) => {
        state.status = 302;
        state.headers.set('location', path);
      },
    };
    const request = { plainCookie: () => undefined, url: () => '/durable' };
    return { ctx: { response, request } as never, state };
  }

  async function runEnforce(
    authorize: (ctx: unknown) => boolean | Promise<boolean>,
    mode: 'page' | 'api' = 'page',
    extra: Record<string, unknown> = {},
  ) {
    const { default: DashboardProvider } = await import('../providers/dashboard_provider.js');
    const { resolveConfig } = await import('../src/dashboard/define_config.js');
    const provider = new DashboardProvider({} as never);
    const config = resolveConfig({ authorize: authorize as never, ...extra });
    const { ctx, state } = fakeCtx();
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

  it('Mode-A-only with no session gets the "open from your app" page', async () => {
    const { allowed, state } = await runEnforce(() => true, 'page', {
      dashboardAuth: { secret: 's'.repeat(32), session: () => null },
    });
    expect(allowed).toBe(false);
    expect(state.status).toBe(401);
    expect(state.body).toContain('<h1>Open this console from your app</h1>');
  });
});

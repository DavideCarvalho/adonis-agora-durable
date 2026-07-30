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
      redirect: (path: string) => {
        state.status = 302;
        state.headers.set('location', path);
      },
    };
    return { ctx: { response } as never, state };
  }

  async function runEnforce(authorize: (ctx: unknown) => boolean | Promise<boolean>) {
    const { default: DashboardProvider } = await import('../providers/dashboard_provider.js');
    const { resolveConfig } = await import('../src/dashboard/define_config.js');
    const provider = new DashboardProvider({} as never);
    const config = resolveConfig({ authorize: authorize as never });
    const { ctx, state } = fakeCtx();
    // `enforce` is TS-private (compile-time only) — reached via index access on purpose.
    const allowed = await (
      provider as unknown as {
        enforce(c: unknown, x: unknown, m: 'page' | 'api'): Promise<boolean>;
      }
    ).enforce(config, ctx, 'page');
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

  it('a hook that just returns false still gets the uniform 403', async () => {
    const { allowed, state } = await runEnforce(() => false);
    expect(allowed).toBe(false);
    expect(state.status).toBe(403);
    expect(state.body).toEqual({ error: 'forbidden' });
  });
});

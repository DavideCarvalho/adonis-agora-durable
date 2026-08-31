import { readFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import {
  type AccessDeniedInfo,
  resolveAccessDeniedPage,
} from '../src/dashboard/access_denied_page.js';
import {
  performLogin,
  performSession,
  type ResolvedDashboardAuth,
  readSession,
  SESSION_COOKIE_NAME,
  sanitizeReturnTo,
} from '../src/dashboard/auth.js';
import {
  type CompatSource,
  compat,
  enumerateLiveFleet,
  type FleetTransport,
  mergeFleets,
} from '../src/dashboard/compat.js';
import {
  type DurableDashboardConfig,
  type ResolvedDurableDashboardConfig,
  resolveConfig,
} from '../src/dashboard/define_config.js';
import { BlockedDiagnosticsRecorder } from '../src/dashboard/diagnostics-recorder.js';
import { dashboardEngineForRole } from '../src/dashboard/gateway-adapter.js';
import {
  type ApiRequest,
  type ApiResponse,
  bulkAction,
  cancelRun,
  continueRun,
  type DashboardEngine,
  type Deps,
  getRun,
  health,
  listRuns,
  redispatchPendingRun,
  retryRun,
  retryWithInputRun,
  topology,
  workers,
} from '../src/dashboard/handlers.js';
import { renderLoginPage } from '../src/dashboard/login_page.js';
import { contentTypeFor, renderIndexHtml } from '../src/dashboard/spa.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/index.js';
import { DURABLE_TRANSPORT } from '../src/role_bindings.js';

/**
 * Directory of the built SPA (`dist/spa`, copied in by `copy:stubs` — see `package.json`), relative to
 * this compiled provider (`dist/providers`). Resolved lazily (not at module scope) for the same reason
 * `@adonis-agora/media-dashboard`'s provider resolves its SPA directory lazily: `fileURLToPath` throws
 * on any non-`file:` `import.meta.url`, which would make this provider unimportable under a test
 * runner that doesn't use real file URLs.
 */
let spaDir: string | undefined;
function spaDirectory(): string {
  spaDir ??= fileURLToPath(new URL('../assets/spa/', import.meta.url));
  return spaDir;
}

/**
 * Mounts the durable dashboard into an AdonisJS app: the `@adonis-agora/durable-dashboard` React SPA
 * (a JSON API over the {@link WorkflowEngine}'s read/control surface, served under a configurable
 * path).
 *
 * Routes (relative to the configured `path`, default `/durable`):
 * - `GET  /`                          -> the dashboard SPA's `index.html`
 * - `GET  /assets/:file`              -> the SPA's hashed JS/CSS bundle
 * - `GET  /api/runs`                  -> list runs (status/workflow/tag/namespace/attr filters, paged)
 * - `GET  /api/runs/:id`              -> run detail (run + step timeline + children)
 * - `GET  /api/runs/:id/stream`       -> SSE live-tail of one run's lifecycle events
 * - `POST /api/runs/:id/retry`        -> re-enqueue the run
 * - `POST /api/runs/:id/retry-with-input` -> fix-and-replay: start a corrected linked run
 * - `POST /api/runs/:id/redispatch`   -> re-dispatch a run's lost pending remote steps
 * - `POST /api/runs/:id/cancel`       -> cancel the run
 * - `POST /api/runs/:id/continue`     -> resume a run paused at a breakpoint
 * - `POST /api/bulk/:action`          -> bulk retry/cancel every run matching a filter
 * - `GET  /api/health`                -> worker-group health (compact shape)
 * - `GET  /api/workers`               -> worker-group health (full heartbeats; SPA)
 * - `GET  /api/topology`              -> this deployment's durable role
 * - `GET  /api/compat`                -> fleet health / protocol-compatibility panel
 */
export default class DashboardProvider {
  constructor(protected app: ApplicationService) {}

  /** Warn once so a throwing `login`/`session` hook doesn't spam the logs on every failed attempt. */
  private warnedOnHookThrow = false;

  /**
   * Captures the engine's `capability.unavailable` / `protocol.incompatible` diagnostics events so the
   * `/compat` health panel can render each blocked run's structured delta + the live-fleet compat view
   * (design §7.6, §10). Store-role only — attached in {@link boot}; a `tenant` pod owns no engine.
   */
  private readonly diagnostics = new BlockedDiagnosticsRecorder();
  /** Detach handle for the diagnostics subscription, released on {@link shutdown}. */
  private detachDiagnostics: (() => void) | null = null;

  /** The active durable role (`standalone` when no `durable` config is present — today's default). */
  private durableRole(): 'standalone' | 'control-plane' | 'tenant' {
    return this.app.config.get<DurableConfig>('durable', {}).role ?? 'standalone';
  }

  async boot() {
    const config = resolveConfig(
      this.app.config.get<DurableDashboardConfig>('durable_dashboard', {}),
    );
    if (!config.enabled) return;

    const role = this.durableRole();

    // Route registration can't happen synchronously in `boot()` — see the long-standing note this
    // provider always carried: the router singleton isn't committed until the app's "booted" hooks
    // run, which fire strictly AFTER every provider's own `boot()`.
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      this.registerRoutes(router, config, role);
      await this.attachDiagnostics(role);
    });
  }

  private async attachDiagnostics(role: 'standalone' | 'control-plane' | 'tenant'): Promise<void> {
    if (role === 'tenant') return;
    try {
      const engine = await this.app.container.make(WorkflowEngine);
      this.detachDiagnostics = this.diagnostics.attach(engine);
    } catch {
      // No store-backed engine available — the compat panel degrades to reason-only blocked runs.
    }
  }

  private registerRoutes(
    router: HttpRouterService,
    config: ResolvedDurableDashboardConfig,
    role: 'standalone' | 'control-plane' | 'tenant',
  ): void {
    const apiBase = `${config.path}/api`;

    // Resolve the dashboard's read/control port lazily per request, branched by role (design §5/§8):
    // a store role adapts the engine (built by @adonis-agora/durable's provider); a store-less `tenant`
    // pod resolves the DURABLE_RUN_GATEWAY token (a ProxyRunGateway) and adapts it — NO engine, NO store.
    const resolveEngine = (): Promise<DashboardEngine> =>
      dashboardEngineForRole(role, this.app.container, WorkflowEngine);
    const deps = async (): Promise<Deps> => ({ engine: await resolveEngine() });

    // Built-in `dashboardAuth` (Mode A `session` and/or Mode B `login`, opt-in). Registered ONLY when
    // configured, so omitting `dashboardAuth` leaves route registration byte-for-byte as it was. These
    // endpoints are public (behind NEITHER guard): they MINT the session the guard checks for.
    if (config.dashboardAuth) {
      this.registerAuthRoutes(router, config, config.dashboardAuth);
    }

    this.registerSpaRoutes(router, config, apiBase);

    // JSON API.
    const json = (handler: (d: Deps, req: ApiRequest) => Promise<ApiResponse>) => {
      return async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        try {
          const result = await handler(await deps(), toApiRequest(ctx));
          return ctx.response.status(result.status).json(result.body);
        } catch (error) {
          return ctx.response
            .status(500)
            .json({ error: error instanceof Error ? error.message : 'internal error' });
        }
      };
    };

    router.get(`${apiBase}/runs`, json(listRuns)).as('durable_dashboard.runs.index');
    router.get(`${apiBase}/runs/:id`, json(getRun)).as('durable_dashboard.runs.show');
    router.post(`${apiBase}/runs/:id/retry`, json(retryRun)).as('durable_dashboard.runs.retry');
    router
      .post(`${apiBase}/runs/:id/retry-with-input`, json(retryWithInputRun))
      .as('durable_dashboard.runs.retry_with_input');
    router
      .post(`${apiBase}/runs/:id/redispatch`, json(redispatchPendingRun))
      .as('durable_dashboard.runs.redispatch');
    router.post(`${apiBase}/runs/:id/cancel`, json(cancelRun)).as('durable_dashboard.runs.cancel');
    router
      .post(`${apiBase}/runs/:id/continue`, json(continueRun))
      .as('durable_dashboard.runs.continue');
    router.post(`${apiBase}/bulk/:action`, json(bulkAction)).as('durable_dashboard.bulk');
    router
      .get(
        `${apiBase}/health`,
        json((d) => health(d)),
      )
      .as('durable_dashboard.health');
    router
      .get(
        `${apiBase}/workers`,
        json((d) => workers(d)),
      )
      .as('durable_dashboard.workers');
    router
      .get(`${apiBase}/topology`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        // Only a `TenantConfig` carries a `partition` (its `<name>@<tenant>` routing suffix, spec
        // §6.1) — the field this dashboard's `DurableTopology.tenant` badge actually names.
        const durableConfig = this.app.config.get<DurableConfig>('durable', {});
        const tenant = durableConfig.role === 'tenant' ? durableConfig.partition : undefined;
        const result = topology(role, tenant);
        return ctx.response.status(result.status).json(result.body);
      })
      .as('durable_dashboard.topology');

    // Live-tail one run's lifecycle events over SSE — needs the raw HTTP response, so it's wired
    // directly here rather than through the JSON `ApiResponse` convention the other routes share.
    router
      .get(`${apiBase}/runs/:id/stream`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        const id = ctx.params.id as string;
        const engine = await resolveEngine();
        await this.streamRun(ctx, engine, id);
      })
      .as('durable_dashboard.runs.stream');

    // Fleet health / protocol-compatibility panel (design §7.6, §10): per queue/group/pod protocol +
    // negotiated level + red-flag reason on incompatibility, plus blocked runs with their structured delta.
    router
      .get(`${apiBase}/compat`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        try {
          const result = await compat(await this.compatSource(await resolveEngine()));
          return ctx.response.status(result.status).json(result.body);
        } catch (error) {
          return ctx.response
            .status(500)
            .json({ error: error instanceof Error ? error.message : 'internal error' });
        }
      })
      .as('durable_dashboard.compat');
  }

  /** Mount the React SPA at `config.path` plus its hashed asset bundle. */
  private registerSpaRoutes(
    router: HttpRouterService,
    config: ResolvedDurableDashboardConfig,
    apiBase: string,
  ): void {
    const indexPath = config.path === '' ? '/' : config.path;

    router
      .get(indexPath, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'page'))) return;
        let html: string;
        try {
          html = await readFile(resolvePath(spaDirectory(), 'index.html'), 'utf8');
        } catch {
          return ctx.response
            .status(404)
            .send(
              'The durable dashboard SPA is not built. Run `pnpm --filter @adonis-agora/durable-dashboard build` (or the package build) to emit dist/spa.',
            );
        }
        return ctx.response
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-store, must-revalidate')
          .send(renderIndexHtml(html, config.path, apiBase));
      })
      .as('durable_dashboard.index');

    router
      .get(`${config.path}/assets/:file`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'page'))) return;
        const file = basename(String(ctx.params.file));
        const root = resolvePath(spaDirectory(), 'assets');
        const assetPath = resolvePath(root, file);
        if (!assetPath.startsWith(root)) return ctx.response.status(404).send('');
        let bytes: Buffer;
        try {
          bytes = await readFile(assetPath);
        } catch {
          return ctx.response.status(404).send('');
        }
        return ctx.response
          .header('content-type', contentTypeFor(file))
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(bytes);
      })
      .as('durable_dashboard.assets');
  }

  /**
   * Stream one run's lifecycle events as `text/event-stream`, via AdonisJS's `response.stream()` (a
   * managed pipe with graceful error handling — no raw `ServerResponse` writes). The stream stays
   * open until the client disconnects, at which point the engine subscription is torn down and the
   * stream ended, mirroring the NestJS sibling's `@Sse` route (`gateway.subscribe` unsubscribed on
   * teardown).
   */
  private async streamRun(ctx: HttpContext, engine: DashboardEngine, runId: string): Promise<void> {
    ctx.response.header('content-type', 'text/event-stream');
    ctx.response.header('cache-control', 'no-cache');
    ctx.response.header('connection', 'keep-alive');
    ctx.response.header('x-accel-buffering', 'no');

    const stream = new PassThrough();
    const unsubscribe = engine.subscribe(runId, (event) => {
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const cleanup = () => {
      unsubscribe();
      stream.end();
    };
    ctx.request.request.on('close', cleanup);
    ctx.response.stream(stream);
  }

  private async compatSource(engine: DashboardEngine): Promise<CompatSource> {
    const live = await enumerateLiveFleet(await this.fleetTransport());
    const fleet = mergeFleets(this.diagnostics.fleet(), live);
    return {
      controlPlaneDescriptor: () => this.diagnostics.controlPlaneDescriptor(),
      fleet: () => fleet,
      blockedRuns: () => engine.listRuns({ statuses: ['blocked'] }),
      diagnosticsFor: (runId) => this.diagnostics.diagnosticsFor(runId),
    };
  }

  private async fleetTransport(): Promise<FleetTransport | null> {
    try {
      return (await this.app.container.make(DURABLE_TRANSPORT)) as FleetTransport;
    } catch {
      return null;
    }
  }

  /**
   * Mount the built-in `dashboardAuth` endpoints under `basePath`. All are public (no guard): they
   * create/destroy the session the {@link enforce} guard checks for.
   *
   * - `GET  <base>/login`  -> the server-rendered login page (Mode B only).
   * - `POST <base>/login`  -> verifies credentials via the host `login` hook and mints the cookie.
   * - `POST <base>/session` -> Mode A: verifies the HOST APP's own auth (off the raw request) via the
   *    `session` hook and mints the cookie. No body — the hook reads whatever it needs off `request`.
   *    `204` on success, uniform `401` on denial. Mirrors `@dudousxd/nestjs-durable-dashboard`'s
   *    `DurableAuthController.session` and `client/console-session.ts`'s `mintDurableConsoleSession`.
   * - `GET  <base>/logout` -> clears the cookie and redirects to the login page (Mode B) or the
   *    dashboard root (Mode A only). A plain `GET` (idempotent, only ever destroys the caller's own
   *    session) so a simple `<a href>` works.
   */
  private registerAuthRoutes(
    router: HttpRouterService,
    config: ResolvedDurableDashboardConfig,
    auth: ResolvedDashboardAuth,
  ): void {
    const loginPath = `${config.path}/login`;
    const sessionPath = `${config.path}/session`;
    const logoutPath = `${config.path}/logout`;

    if (auth.login) {
      router
        .get(loginPath, async (ctx) => {
          ctx.response.header('content-type', 'text/html; charset=utf-8');
          ctx.response.header('cache-control', 'no-store, must-revalidate');
          const qs = ctx.request.qs();
          const nonce = cspNonce(ctx);
          return ctx.response.send(
            renderLoginPage(config.path, {
              ...(nonce !== undefined ? { nonce } : {}),
              error: qs.error !== undefined,
              returnTo: qs.returnTo,
            }),
          );
        })
        .as('durable_dashboard.login.page');

      // Two callers: the page's own `fetch` (JSON in, JSON out — `{ redirectTo }` / `{ error }`)
      // and, with JavaScript off or its inline script dropped by a CSP, the same page as a classic
      // form post (form-encoded in, a redirect out: to `returnTo` on success, back to the login
      // page with `?error` on failure). Same hook, same cookie, same uniform failure either way.
      router
        .post(loginPath, async (ctx) => {
          const body = ctx.request.body();
          const outcome = await performLogin(auth, body, config.path);
          const form = isFormPost(ctx);
          const backToLogin = () =>
            ctx.response
              .redirect()
              .withQs({
                error: '1',
                returnTo: sanitizeReturnTo(
                  (body as { returnTo?: unknown } | null)?.returnTo,
                  config.path || '/',
                ),
              })
              .toPath(loginPath);
          if (outcome.kind === 'bad-request') {
            if (form) return backToLogin();
            return ctx.response.status(400).json({ error: outcome.message });
          }
          if (outcome.kind === 'unauthorized') {
            this.warnHookThrow(outcome.hookError);
            if (form) return backToLogin();
            return ctx.response.status(401).json({ error: outcome.message });
          }
          this.writeSessionCookie(ctx, auth, outcome.cookieValue);
          if (form) return ctx.response.redirect().toPath(outcome.redirectTo);
          return ctx.response.status(200).json({ redirectTo: outcome.redirectTo });
        })
        .as('durable_dashboard.login.submit');
    }

    if (auth.session) {
      router
        .post(sessionPath, async (ctx) => {
          const outcome = await performSession(auth, ctx.request.request);
          if (outcome.kind === 'unauthorized') {
            this.warnHookThrow(outcome.hookError);
            return ctx.response.status(401).json({ error: 'unauthorized' });
          }
          this.writeSessionCookie(ctx, auth, outcome.cookieValue);
          return ctx.response.status(204).send('');
        })
        .as('durable_dashboard.session.mint');
    }

    router
      .get(logoutPath, async (ctx) => {
        ctx.response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
        return ctx.response.redirect().toPath(auth.login ? loginPath : config.path || '/');
      })
      .as('durable_dashboard.logout');
  }

  private async warnHookThrow(hookError: unknown): Promise<void> {
    if (hookError === undefined || this.warnedOnHookThrow) return;
    this.warnedOnHookThrow = true;
    const message = hookError instanceof Error ? hookError.message : String(hookError);
    const logger = await this.app.container.make('logger');
    logger.warn(`dashboardAuth login/session hook threw; treating as denial. ${message}`);
  }

  /**
   * Run the guards for a dashboard resource. Composes the existing `authorize` hook (bearer
   * token/custom) with the optional `dashboardAuth` session guard — BOTH must pass:
   *
   * 1. `authorize` fails -> `403`: the built-in (or host-customised) access-denied PAGE for a
   *    `page` request, `{ error: 'forbidden' }` JSON for an `api` request.
   * 2. `dashboardAuth` configured AND no valid session -> for a `page` request, redirect `302` to
   *    the login page (Mode B) carrying a sanitized `returnTo`, or the `401` "open this console
   *    from your app" page (Mode A only, no login page to redirect to); for an `api` request, a
   *    plain `401 { error: 'unauthorized', auth: { modes } }` — the `modes` list lets the SPA's
   *    client (`durable-client.ts`) decide whether to offer the login page.
   *
   * When `dashboardAuth` is unconfigured only step 1 runs.
   * Returns `false` (and has already written the response) when the request must short-circuit.
   */
  private async enforce(
    config: ResolvedDurableDashboardConfig,
    ctx: HttpContext,
    mode: 'page' | 'api',
  ): Promise<boolean> {
    const allowed = await config.authorize(ctx);
    if (!allowed) {
      if (mode === 'page') {
        await this.denyPage(ctx, config, { status: 403, reason: 'forbidden' });
      } else if (!ctx.response.getHeader('location')) {
        ctx.response.status(403).json({ error: 'forbidden' });
      }
      return false;
    }

    const auth = config.dashboardAuth;
    if (!auth) return true;

    const session = readSession(auth, this.readSessionCookie(ctx));
    if (session) return true;

    if (mode === 'page') {
      if (auth.login) {
        const returnTo = ctx.request.url(true);
        ctx.response.redirect().withQs('returnTo', returnTo).toPath(`${config.path}/login`);
        return false;
      }
      // Mode A only: there's no login page to send the browser to — this deployment expects the
      // host app to mint a session via `POST <path>/session` before ever navigating here.
      await this.denyPage(ctx, config, { status: 401, reason: 'session-required' });
      return false;
    }
    ctx.response.status(401).json({ error: 'unauthorized', auth: { modes: auth.modes } });
    return false;
  }

  /**
   * Answer a refused PAGE navigation with HTML instead of the API's JSON: the built-in page, the
   * host's tweaked version of it, or whatever the host's `accessDenied` renderer produced. Stands
   * down when the request is already answered — an `authorize` hook (or the renderer) that wrote a
   * redirect keeps it; the provider never overwrites a `location` header.
   */
  private async denyPage(
    ctx: HttpContext,
    config: ResolvedDurableDashboardConfig,
    denial: Pick<AccessDeniedInfo, 'status' | 'reason'>,
  ): Promise<void> {
    const answered = () => responseAnswered(ctx);
    if (answered()) return;
    const nonce = cspNonce(ctx);
    const info: AccessDeniedInfo = {
      ...denial,
      basePath: config.path,
      ...(config.dashboardAuth?.login ? { loginHref: `${config.path}/login` } : {}),
      ...(nonce !== undefined ? { nonce } : {}),
    };
    const html = await resolveAccessDeniedPage(info, config.accessDenied, ctx, answered);
    if (html === null) return;
    ctx.response
      .status(info.status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store, must-revalidate')
      .send(html);
  }

  private readSessionCookie(ctx: HttpContext): string | undefined {
    const value = ctx.request.plainCookie(SESSION_COOKIE_NAME, undefined, false);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  private writeSessionCookie(ctx: HttpContext, auth: ResolvedDashboardAuth, value: string): void {
    ctx.response.plainCookie(SESSION_COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.request.secure(),
      path: '/',
      maxAge: Math.floor(auth.ttlMs / 1000),
      encode: false,
    });
  }

  async shutdown(): Promise<void> {
    this.detachDiagnostics?.();
    this.detachDiagnostics = null;
  }
}

/**
 * Whether something already answered this request: a redirect (`location` header — the signal the
 * `authorize` contract has always honoured) or a body queued on the response. The body check reads
 * AdonisJS's `response.hasLazyBody` structurally so a plain-object `ctx` double in a unit test
 * (which has neither) still works.
 */
function responseAnswered(ctx: HttpContext): boolean {
  if (ctx.response.getHeader('location')) return true;
  const response = ctx.response as unknown as { hasLazyBody?: unknown; headersSent?: unknown };
  return response.hasLazyBody === true || response.headersSent === true;
}

/**
 * The request's CSP nonce when the host runs `@adonisjs/shield` with `@nonce` in its policy (shield
 * exposes it as `response.nonce`). Read structurally: this package neither depends on shield nor
 * cares which middleware minted the nonce — only that the page's inline `<style>` carries it.
 */
function cspNonce(ctx: HttpContext): string | undefined {
  const nonce = (ctx.response as unknown as { nonce?: unknown }).nonce;
  return typeof nonce === 'string' && nonce !== '' ? nonce : undefined;
}

/**
 * Whether a login `POST` came from a classic HTML form submit (form-encoded — JavaScript off, or
 * the page's inline script dropped by a CSP) rather than the page's own JSON `fetch`. Decides
 * whether the reply is a redirect (a browser navigating) or JSON (a script awaiting it).
 */
function isFormPost(ctx: HttpContext): boolean {
  const type = ctx.request.header('content-type') ?? '';
  return type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data');
}

/** Adapt an AdonisJS `HttpContext` to the framework-light {@link ApiRequest}. */
function toApiRequest(ctx: HttpContext): ApiRequest {
  return {
    params: ctx.params as Record<string, string | undefined>,
    query: ctx.request.qs() as Record<string, string | string[] | undefined>,
    body: ctx.request.body(),
  };
}

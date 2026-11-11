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
  type CompatSource,
  compat,
  enumerateLiveFleet,
  type FleetTransport,
  mergeFleets,
} from '../src/dashboard/compat.js';
import {
  type DashboardAuditEntry,
  type DurableDashboardConfig,
  NO_AUTHORIZE_WARNING,
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
  completeTaskRun,
  continueRun,
  type DashboardEngine,
  type Deps,
  deliverWebhook,
  failTaskRun,
  getFanMembers,
  getRun,
  getRunEvent,
  health,
  listRuns,
  listSchedules,
  metricsText,
  redispatchPendingRun,
  republishLifecycleRun,
  retryRun,
  retryWithInputRun,
  runValues,
  scheduleAction,
  signalRun,
  topology,
  updateRun,
  workers,
  workflowLifecycle,
} from '../src/dashboard/handlers.js';
import { openApiDocument } from '../src/dashboard/openapi.js';
import { contentTypeFor, renderIndexHtml } from '../src/dashboard/spa.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/index.js';
import { collectMetrics, type MetricsCollector } from '../src/metrics.js';
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
 * - `GET  /api/runs/values`           -> distinct values of one filter axis, with counts (pickers)
 * - `GET  /api/runs/:id`              -> run detail (run + step timeline + children; fans over 50
 *                                         members summarized unless `?full=true`)
 * - `GET  /api/runs/:id/fans/:group`  -> one page of a summarized fan's members
 * - `GET  /api/runs/:id/stream`       -> SSE live-tail of one run's lifecycle events
 * - `POST /api/runs/:id/retry`        -> re-enqueue the run
 * - `POST /api/runs/:id/retry-with-input` -> fix-and-replay: start a corrected linked run
 * - `POST /api/runs/:id/redispatch`   -> re-dispatch a run's lost pending remote steps
 * - `POST /api/runs/:id/republish-lifecycle` -> publish a settled run's lifecycle event again
 * - `POST /api/runs/:id/cancel`       -> cancel the run
 * - `POST /api/runs/:id/continue`     -> resume a run paused at a breakpoint
 * - `POST /api/runs/:id/signal`       -> deliver a signal payload to a waited token
 * - `POST /api/runs/:id/updates/:name` -> deliver a validated update (ctx.onUpdate)
 * - `POST /api/runs/:id/tasks/:name/complete` -> complete an external ctx.task
 * - `POST /api/runs/:id/tasks/:name/fail`     -> fail an external ctx.task
 * - `GET  /api/workflows/:name/lifecycle` -> who starts whom through lifecycle events, for a workflow
 * - `GET  /api/schedules`             -> ticked schedules with control state + fire windows
 * - `POST /api/schedules/:key/:action`-> pause / resume / trigger a schedule at runtime
 * - `POST /api/bulk/:action`          -> bulk retry/cancel every run matching a filter
 * - `GET  /api/health`                -> worker-group health (compact shape)
 * - `GET  /api/workers`               -> worker-group health (full heartbeats; SPA)
 * - `GET  /api/topology`              -> this deployment's durable role
 * - `GET  /api/compat`                -> fleet health / protocol-compatibility panel
 * - `GET  /api/openapi.json`          -> the machine-readable API contract (OpenAPI 3.1)
 */
export default class DashboardProvider {
  constructor(protected app: ApplicationService) {}

  private warnedOnAuthorizeThrow = false;

  /** SSE connections currently open, per client address (and in total) — see streamRun. */
  private readonly sseByAddress = new Map<string, number>();
  private sseTotal = 0;

  /**
   * Captures the engine's `capability.unavailable` / `protocol.incompatible` diagnostics events so the
   * `/compat` health panel can render each blocked run's structured delta + the live-fleet compat view
   * (design §7.6, §10). Store-role only — attached in {@link boot}; a `tenant` pod owns no engine.
   */
  private readonly diagnostics = new BlockedDiagnosticsRecorder();
  /** Detach handle for the diagnostics subscription, released on {@link shutdown}. */
  private detachDiagnostics: (() => void) | null = null;
  /** This process's event counters for `GET /metrics` (store roles; a tenant pod has no engine). */
  private metricsCollector: MetricsCollector | null = null;

  /** The active durable role (`standalone` when no `durable` config is present — today's default). */
  private durableRole(): 'standalone' | 'control-plane' | 'tenant' {
    return this.app.config.get<DurableConfig>('durable', {}).role ?? 'standalone';
  }

  async boot() {
    const config = resolveConfig(
      this.app.config.get<DurableDashboardConfig>('durable_dashboard', {}),
      { inProduction: this.app.inProduction },
    );
    if (!config.enabled) return;
    if (!config.authorizeConfigured) await this.warnNoAuthorize();

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
    // A warmed-up app (`node ace codegen`) never starts nor shuts down: resolving the engine would open
    // the transport/store connections nothing closes, and the command would never exit. The routes are
    // still registered above (codegen reads them); the engine is resolved per request.
    if ((this.app as { getMode?: () => string }).getMode?.() === 'warmup') return;
    try {
      const engine = await this.app.container.make(WorkflowEngine);
      // The console's live tail follows runs of every namespace, whatever this engine's own is.
      engine.observeAllNamespaces();
      this.detachDiagnostics = this.diagnostics.attach(engine);
      this.metricsCollector = collectMetrics(engine);
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
    const deps = async (): Promise<Deps> => ({
      engine: await resolveEngine(),
      ...(config.redact ? { redact: config.redact } : {}),
      ...(this.metricsCollector ? { metrics: this.metricsCollector } : {}),
    });

    this.registerSpaRoutes(router, config, apiBase);

    // JSON API.
    const json = (handler: (d: Deps, req: ApiRequest) => Promise<ApiResponse>) => {
      return async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        // Attribution for every mutating attempt — BEFORE the handler, so even a failing action is
        // on record. Reads (GET) are not audited (they'd drown the log).
        if (isMutatingMethod(ctx)) this.audit(config, ctx);
        try {
          const result = await handler(await deps(), toApiRequest(ctx));
          for (const [name, value] of Object.entries(result.headers ?? {})) {
            ctx.response.header(name, value);
          }
          // A 304 carries no body (its validator rides in the headers).
          if (result.status === 304) return ctx.response.status(304).send('');
          return ctx.response.status(result.status).json(result.body);
        } catch (error) {
          // Generic body on a 500: raw driver/store messages (connection strings, SQL fragments)
          // must not flow to API callers. The detail goes to the app logger instead.
          void this.logServerError(error);
          return ctx.response.status(500).json({ error: 'internal error' });
        }
      };
    };

    router.get(`${apiBase}/runs`, json(listRuns)).as('durable_dashboard.runs.index');
    // Registered BEFORE `/runs/:id` so `values` isn't captured as a run id.
    router.get(`${apiBase}/runs/values`, json(runValues)).as('durable_dashboard.runs.values');
    router.get(`${apiBase}/runs/:id`, json(getRun)).as('durable_dashboard.runs.show');
    router
      .get(`${apiBase}/runs/:id/fans/:group`, json(getFanMembers))
      .as('durable_dashboard.runs.fans');
    router.post(`${apiBase}/runs/:id/retry`, json(retryRun)).as('durable_dashboard.runs.retry');
    router
      .post(`${apiBase}/runs/:id/retry-with-input`, json(retryWithInputRun))
      .as('durable_dashboard.runs.retry_with_input');
    router
      .post(`${apiBase}/runs/:id/redispatch`, json(redispatchPendingRun))
      .as('durable_dashboard.runs.redispatch');
    router
      .post(`${apiBase}/runs/:id/republish-lifecycle`, json(republishLifecycleRun))
      .as('durable_dashboard.runs.republish_lifecycle');
    router.post(`${apiBase}/runs/:id/cancel`, json(cancelRun)).as('durable_dashboard.runs.cancel');
    router
      .get(`${apiBase}/workflows/:name/lifecycle`, json(workflowLifecycle))
      .as('durable_dashboard.workflows.lifecycle');
    router
      .post(`${apiBase}/runs/:id/continue`, json(continueRun))
      .as('durable_dashboard.runs.continue');
    // Human-in-the-loop verbs: deliver a signal / validated update / task completion from the
    // console — the runs list already names what a suspended run is waiting on; these let the
    // operator act on it.
    router.post(`${apiBase}/runs/:id/signal`, json(signalRun)).as('durable_dashboard.runs.signal');
    router
      .post(`${apiBase}/runs/:id/updates/:name`, json(updateRun))
      .as('durable_dashboard.runs.update');
    router
      .post(`${apiBase}/runs/:id/tasks/:name/complete`, json(completeTaskRun))
      .as('durable_dashboard.runs.task_complete');
    router
      .post(`${apiBase}/runs/:id/tasks/:name/fail`, json(failTaskRun))
      .as('durable_dashboard.runs.task_fail');
    // Live query of a value the run published with `ctx.setEvent` (no side effect).
    router
      .get(`${apiBase}/runs/:id/events/:key`, json(getRunEvent))
      .as('durable_dashboard.runs.event');
    // `ctx.webhook()` callbacks. Behind the same guard as every route here: see `deliverWebhook`.
    router
      .post(`${apiBase}/webhooks/:token`, json(deliverWebhook))
      .as('durable_dashboard.webhooks.deliver');
    // Prometheus scrape: this process's counters plus backlog and worker gauges.
    router
      .get(`${apiBase}/metrics`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        try {
          const text = await metricsText(await deps());
          ctx.response.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          return ctx.response.status(200).send(text);
        } catch (error) {
          void this.logServerError(error);
          return ctx.response.status(500).json({ error: 'internal error' });
        }
      })
      .as('durable_dashboard.metrics');
    // Runtime schedule control: list the ticked schedules, pause/resume one fleet-wide (runtime
    // override; a deploy resets to the config), or fire its current window now (idempotent).
    router.get(`${apiBase}/schedules`, json(listSchedules)).as('durable_dashboard.schedules.index');
    // The machine-readable API contract (OpenAPI 3.1) — regenerate clients from it, diff it in CI.
    router
      .get(`${apiBase}/openapi.json`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api'))) return;
        return ctx.response.status(200).json(openApiDocument(apiBase));
      })
      .as('durable_dashboard.openapi');
    router
      .post(`${apiBase}/schedules/:key/:action`, json(scheduleAction))
      .as('durable_dashboard.schedules.action');
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
          void this.logServerError(error);
          return ctx.response.status(500).json({ error: 'internal error' });
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
    // Connection budget: each open stream is one listener on the engine's GLOBAL emitter plus one
    // held socket — uncapped, N tabs (or a leak) made every engine event pay O(N) filtering and
    // pinned N sockets forever. 100 per instance / 10 per client address is far above any human use.
    const address = ctx.request.ip() || 'unknown';
    const perAddress = this.sseByAddress.get(address) ?? 0;
    if (this.sseTotal >= 100 || perAddress >= 10) {
      ctx.response.status(429).json({ error: 'too many open event streams' });
      return;
    }
    this.sseTotal += 1;
    this.sseByAddress.set(address, perAddress + 1);

    ctx.response.header('content-type', 'text/event-stream');
    ctx.response.header('cache-control', 'no-cache');
    ctx.response.header('connection', 'keep-alive');
    ctx.response.header('x-accel-buffering', 'no');

    const stream = new PassThrough();
    const unsubscribe = engine.subscribe(runId, (event) => {
      stream.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    // Server-side heartbeat: a comment line every 25s keeps intermediaries from silently reaping an
    // idle stream AND surfaces a dead client to Node (the write errors, `close` fires, we clean up)
    // instead of holding the subscription forever.
    const ping = setInterval(() => {
      stream.write(': ping\n\n');
    }, 25_000);
    (ping as { unref?: () => void }).unref?.();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(ping);
      unsubscribe();
      stream.end();
      this.sseTotal -= 1;
      const left = (this.sseByAddress.get(address) ?? 1) - 1;
      if (left <= 0) this.sseByAddress.delete(address);
      else this.sseByAddress.set(address, left);
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

  /** Record one mutating console action (see DashboardAuditEntry). Never throws into the request. */
  private audit(config: ResolvedDurableDashboardConfig, ctx: HttpContext): void {
    try {
      const entry: DashboardAuditEntry = {
        at: new Date(),
        actor: auditActor(ctx),
        method: ctx.request.method().toUpperCase(),
        path: ctx.request.url(false),
      };
      if (config.audit) {
        // Typed `void`, but an async hook is assignable to it: catch its rejection too.
        const pending = config.audit(entry) as unknown;
        if (pending instanceof Promise) pending.catch(() => undefined);
        return;
      }
      void this.app.container
        .make('logger')
        .then((logger) => {
          logger.info(
            `[durable_dashboard] audit actor=${entry.actor} ${entry.method} ${entry.path}`,
          );
        })
        .catch(() => undefined);
    } catch {
      /* auditing must never break the action */
    }
  }

  /** Route a handler 500's detail to the app logger (the client only ever sees a generic body). */
  private async logServerError(error: unknown): Promise<void> {
    try {
      const logger = await this.app.container.make('logger');
      logger.error(
        `[durable_dashboard] handler failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    } catch {
      /* logging must never throw into the request */
    }
  }

  private async warnAuthorizeThrow(error: unknown): Promise<void> {
    if (this.warnedOnAuthorizeThrow) return;
    this.warnedOnAuthorizeThrow = true;
    const message = error instanceof Error ? error.message : String(error);
    const logger = await this.app.container.make('logger');
    logger.warn(`[durable_dashboard] authorize hook threw; treating as denial (403). ${message}`);
  }

  /** The once-per-boot warning for a console with no `authorize` (open in dev, 403 in production). */
  private async warnNoAuthorize(): Promise<void> {
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(NO_AUTHORIZE_WARNING);
    } catch {
      console.warn(NO_AUTHORIZE_WARNING);
    }
  }

  /**
   * Run `authorize` for a dashboard resource. On a denial:
   *
   * - `{ redirectTo }`: a `page` request is redirected there (`302`); an `api` request gets
   *   `401 { error: 'unauthenticated', redirectTo }`;
   * - `reason: 'unauthenticated'`: `401` (the access-denied page, or `{ error: 'unauthenticated' }`);
   * - anything else (`false`, `{ allowed: false }`, a throw): `403` (the access-denied page, or
   *   `{ error: 'forbidden' }`).
   *
   * A hook that already answered the request (a redirect, a body) keeps its answer.
   * Returns `false` (and has already written the response) when the request must short-circuit.
   */
  private async enforce(
    config: ResolvedDurableDashboardConfig,
    ctx: HttpContext,
    mode: 'page' | 'api',
  ): Promise<boolean> {
    // CSRF defense-in-depth: a browser-originated CROSS-SITE mutating request is rejected outright,
    // whatever `authorize` would say. The mutating endpoints need no body and read flags from the
    // query string, so without this a malicious page could fire them as SIMPLE cross-origin POSTs
    // (no preflight) against a console the operator's browser is signed in to. Non-browser clients
    // send neither header and pass.
    if (mode === 'api' && isMutatingMethod(ctx) && crossSiteRequest(ctx)) {
      ctx.response.status(403).json({ error: 'cross-site request rejected' });
      return false;
    }
    // The resolved gate never throws: a throwing `authorize` comes back as a 403 carrying the error.
    const decision = await config.authorize(ctx);
    if (decision.allowed) return true;
    if (decision.error !== undefined)
      void this.warnAuthorizeThrow(decision.error).catch(() => undefined);
    const unauthenticated = decision.reason === 'unauthenticated';
    if (mode === 'page') {
      if (decision.redirectTo !== undefined && !responseAnswered(ctx)) {
        ctx.response.redirect().toPath(decision.redirectTo);
        return false;
      }
      await this.denyPage(
        ctx,
        config,
        unauthenticated
          ? { status: 401, reason: 'unauthenticated' }
          : { status: 403, reason: 'forbidden' },
      );
      return false;
    }
    if (responseAnswered(ctx)) return false;
    if (!unauthenticated) {
      ctx.response.status(403).json({ error: 'forbidden' });
    } else if (decision.redirectTo !== undefined) {
      ctx.response.status(401).json({ error: 'unauthenticated', redirectTo: decision.redirectTo });
    } else {
      ctx.response.status(401).json({ error: 'unauthenticated' });
    }
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

  async shutdown(): Promise<void> {
    this.detachDiagnostics?.();
    this.detachDiagnostics = null;
    this.metricsCollector?.stop();
    this.metricsCollector = null;
  }
}

/** Whether this request can change state (everything but GET/HEAD/OPTIONS). Exported for tests. */
export function isMutatingMethod(ctx: HttpContext): boolean {
  const method = ctx.request.method().toUpperCase();
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * Whether a request is browser-originated CROSS-SITE: `sec-fetch-site` when the browser sends it
 * (anything but `same-origin`/`none` is cross), else the `Origin` header must match the request
 * host. Requests carrying neither header (curl, server-side SDKs, same-origin GETs) are not
 * cross-site. Subdomains (`same-site`) count as cross on purpose — the console has no legitimate
 * cross-subdomain POST caller, and strict beats sorry here.
 */
export function crossSiteRequest(ctx: HttpContext): boolean {
  const fetchSite = ctx.request.header('sec-fetch-site');
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none';
  const origin = ctx.request.header('origin');
  if (!origin || origin === 'null') return origin === 'null';
  try {
    return new URL(origin).host !== ctx.request.header('host');
  } catch {
    return true; // an unparseable Origin is not a browser being honest — reject
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
 * Who a mutating console action is attributed to: the signed-in user (`ctx.auth.user`'s `email`,
 * `name` or `id`, read structurally — this package does not depend on `@adonisjs/auth`), `'bearer'`
 * for a caller with an `Authorization` header and no user, else `'anonymous'`.
 */
export function auditActor(ctx: HttpContext): string {
  const user = (ctx as unknown as { auth?: { user?: Record<string, unknown> | null } }).auth?.user;
  if (user) {
    for (const key of ['email', 'name', 'id'] as const) {
      const value = user[key];
      if (typeof value === 'string' && value !== '') return value;
      if (typeof value === 'number') return String(value);
    }
  }
  return ctx.request.header('authorization') !== undefined ? 'bearer' : 'anonymous';
}

/** Adapt an AdonisJS `HttpContext` to the framework-light {@link ApiRequest}. */
function toApiRequest(ctx: HttpContext): ApiRequest {
  return {
    params: ctx.params as Record<string, string | undefined>,
    query: ctx.request.qs() as Record<string, string | string[] | undefined>,
    body: ctx.request.body(),
    headers: { 'if-none-match': ctx.request.header('if-none-match') },
  };
}

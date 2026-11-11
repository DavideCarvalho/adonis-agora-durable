import type { DurableConfig } from '../define_config.js';
import { WorkflowEngine } from '../engine.js';
import { DURABLE_RUN_GATEWAY } from '../role_bindings.js';
import type { RunGateway } from '../run-gateway/interface.js';
import { whenBootedApp } from './booted_app.js';

/**
 * The ACTIVE topology's {@link RunGateway} — the store-less-cluster read/control/start surface (design §8).
 * On `standalone`/`control-plane` it is the store-backed `StoreRunGateway`; on `tenant` it is the
 * `ProxyRunGateway` that round-trips over the wire. App/dashboard/CLI code reads the SAME object either
 * way, so store presence is invisible above this line:
 *
 * ```ts
 * import { runGateway } from '@adonis-agora/durable/services/main'
 * const run = await runGateway.getRun(runId)
 * ```
 */
let runGateway: RunGateway;

/**
 * The singleton {@link WorkflowEngine} — bound ONLY on the store topologies (`standalone`/`control-plane`).
 * A `tenant` pod owns no engine (structural isolation), so this stays `undefined` there; use
 * {@link runGateway} for topology-agnostic access.
 *
 * ```ts
 * import engine from '@adonis-agora/durable/services/main'
 * ```
 */
let engine: WorkflowEngine;

// Source the app from the provider-captured booted instance, NOT `@adonisjs/core/services/app` — a
// pnpm dual-package split can make that import resolve a non-booted core copy (undefined app). See
// {@link ./booted_app.js}. This waits for `DurableProvider.register()` (which feeds `booted_app`),
// then for the boot phase, preserving the eager top-level population consumers already rely on.
const app = await whenBootedApp();
await app.booted(async () => {
  const config = app.config.get<DurableConfig>('durable', {});
  const topology = config.topology ?? 'standalone';
  runGateway = await app.container.make(DURABLE_RUN_GATEWAY);
  // Expose the engine only for store topologies — a tenant pod has no engine binding to resolve.
  if (topology !== 'tenant') {
    engine = await app.container.make(WorkflowEngine);
  }
});

export { engine as default, runGateway };

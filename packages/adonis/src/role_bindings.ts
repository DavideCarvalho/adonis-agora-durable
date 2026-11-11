import type { RunDispatcher, Transport } from './interfaces.js';
import type { RunGateway } from './run-gateway/interface.js';
import type { ProxyTransport } from './run-gateway/proxy-run-gateway.js';
import type {
  ResponderTransport,
  RunRequestResponder,
} from './run-gateway/run-request-responder.js';
import type { DescriptorRedis, WorkerRuntime } from './worker-runtime/index.js';

/**
 * Register the cluster tokens on the container's known-bindings map so `container.make(...)` /
 * `container.singleton(...)` are typed against the concrete objects each token resolves to (the
 * idiomatic AdonisJS way a package publishes abstract bindings). The `run-request-responder` token is
 * `| null` because its factory returns `null` on a transport without the P4 methods (design §8).
 */
declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    '@adonis-agora/durable:run-gateway': RunGateway;
    '@adonis-agora/durable:worker-runtime': WorkerRuntime;
    '@adonis-agora/durable:run-request-responder': RunRequestResponder | null;
    '@adonis-agora/durable:transport': Transport;
  }
}

/**
 * Container binding tokens for the topology-branched, store-less cluster wiring (design §5). Each active
 * topology publishes exactly the objects its topology needs under these keys, so app/dashboard/command code
 * resolves the SAME abstract token regardless of whether a store is present:
 *
 * - {@link DURABLE_RUN_GATEWAY} — the active topology's {@link import('./run-gateway/interface.js').RunGateway}:
 *   a `StoreRunGateway` on `standalone`/`control-plane`, a `ProxyRunGateway` on `tenant`.
 * - {@link DURABLE_WORKER_RUNTIME} — bound ONLY on `tenant`: the store-less
 *   {@link import('./worker-runtime/index.js').WorkerRuntime} the `durable:worker` command drives.
 * - {@link DURABLE_RUN_REQUEST_RESPONDER} — bound on store topologies whose transport carries the P4 methods:
 *   the operator-side {@link import('./run-gateway/run-request-responder.js').RunRequestResponder} tenant
 *   pods round-trip to.
 *
 * They are plain string tokens (like `'router'`/`'logger'`) rather than class constructors because the
 * RunGateway is an INTERFACE with two concrete impls chosen by topology — there is no single class to key on.
 */
export const DURABLE_RUN_GATEWAY = '@adonis-agora/durable:run-gateway';
export const DURABLE_WORKER_RUNTIME = '@adonis-agora/durable:worker-runtime';
export const DURABLE_RUN_REQUEST_RESPONDER = '@adonis-agora/durable:run-request-responder';
/**
 * The store topology's active task {@link import('./interfaces.js').Transport}, published so store-agnostic
 * consumers (the dashboard's fleet-health panel) can enumerate the LIVE worker fleet off it
 * (`listWorkerGroups`/`listWorkerDescriptors`) without reaching into the engine. Bound ONLY on store topologies
 * (`standalone`/`control-plane`); a `tenant` pod never binds it, so its panel degrades to diagnostics-only.
 */
export const DURABLE_TRANSPORT = '@adonis-agora/durable:transport';

/**
 * A no-op {@link RunDispatcher}: a freshly-`start`ed run stays `pending` in the store for a worker's
 * `runPending` poll to pick up, instead of running inline on this instance (design §3 pure coordinator).
 * The `control-plane` topology uses this so `start()` never executes a body on the coordinator — only the
 * store-backed dispatch/recover/timers loop drives runs forward. `standalone` keeps the engine's default
 * in-process (microtask) dispatcher (today's embedded-worker behavior).
 */
export const NOOP_RUN_DISPATCHER: RunDispatcher = { dispatch: () => {} };

/**
 * Structural capability a broker transport MAY expose to hand the worker registry a fresh Redis-ish
 * client to advertise the descriptor + heartbeat on (design §7.2). Kept as an OPTIONAL, capability-checked
 * method (the aviary pattern) so the provider stays decoupled from any single transport: a transport that
 * offers it gets a real {@link import('./worker-runtime/index.js').RedisWorkerRegistry}; one that does not
 * falls back to the no-op registry (the descriptor is still built + observable, just not published).
 */
export interface DescriptorRedisProvider {
  /** Mint a standalone Redis client for the worker descriptor/heartbeat keyspace. The registry OWNS and
   *  closes it. Absent ⇒ the transport can't back a real registry (fall back to no-op). */
  createDescriptorRedis?(): DescriptorRedis;
}

/**
 * Capability-check for {@link DescriptorRedisProvider.createDescriptorRedis} and, when present, mint the
 * descriptor Redis client from the tenant transport. Returns `null` when the transport can't back a real
 * registry — the caller then uses {@link import('./worker-runtime/index.js').NoopWorkerRegistry}.
 */
export function descriptorRedisFrom(transport: unknown): DescriptorRedis | null {
  const t = transport as DescriptorRedisProvider | null | undefined;
  if (t && typeof t.createDescriptorRedis === 'function') return t.createDescriptorRedis();
  return null;
}

/**
 * Capability-check the operator side of the P4 protocol on a transport (design §8). The four methods are
 * OPTIONAL on the full `Transport` (only broker transports carry them), so the provider probes for all
 * four before constructing a {@link import('./run-gateway/run-request-responder.js').RunRequestResponder}
 * over it — the aviary narrowing pattern. Narrows to {@link ResponderTransport} on success.
 */
export function hasResponderCapability(transport: unknown): transport is ResponderTransport {
  const t = transport as Partial<ResponderTransport> | null | undefined;
  return (
    !!t &&
    typeof t.onRunRequest === 'function' &&
    typeof t.onStartRun === 'function' &&
    typeof t.publishRunReply === 'function' &&
    typeof t.publishTenantEvent === 'function'
  );
}

/**
 * Capability-check the tenant side of the P4 protocol on a transport (design §8). Narrows to
 * {@link ProxyTransport} on success. A `tenant` pod whose transport lacks these can't reach the control
 * plane at all, so the provider throws a loud, actionable error rather than binding a dead gateway.
 */
export function hasProxyCapability(transport: unknown): transport is ProxyTransport {
  const t = transport as Partial<ProxyTransport> | null | undefined;
  return (
    !!t &&
    typeof t.dispatchStartRun === 'function' &&
    typeof t.dispatchRunRequest === 'function' &&
    typeof t.onRunReply === 'function' &&
    typeof t.onTenantEvent === 'function'
  );
}

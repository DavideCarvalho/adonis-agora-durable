/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.22.0';

// --- engine + core primitives -----------------------------------------------
export * from './admission.js';
export * from './control-flow-signal.js';
export * from './duration.js';
export * from './engine.js';
export * from './entities.js';
export * from './errors.js';
export * from './event-accumulators.js';
export * from './interfaces.js';
export * from './protocol.js';
export * from './queue.js';
export * from './remote-workflow-executor.js';
export * from './workflow-turn.js';
export * from './tenant-group.js';
export {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepConfig,
  type StepRef,
  stepConfigOf,
  stepNameOf,
} from './step-name-symbol.js';
export * from './step-ref.js';
export * from './step-discovery.js';
export * from './codec-state-store.js';
export * from './diagnostics-bridge.js';
export * from './events.js';
export * from './run-waiting.js';
export * from './metrics.js';
export * from './pollers.js';
export * from './scheduler.js';
export * from './search-attributes.js';
export * from './tokens.js';
export * from './workflow-ref.js';
export * from './workflow-discovery.js';
export {
  BaseWorkflow,
  type WorkflowDispatchOptions,
  type WorkflowEngineResolver,
  setWorkflowEngineResolver,
} from './base-workflow.js';
export { getCurrentWorkflowCtx, workflowAls } from './workflow-als.js';
export { InMemoryStateStore } from './testing/in-memory-state-store.js';
export { InMemoryTransport } from './testing/in-memory-transport.js';

// --- config-driven transport drivers ----------------------------------------
export { transports } from './transports/factory.js';
export type {
  TransportContext,
  TransportFactory,
  MemoryTransportConfig,
  EventEmitterTransportConfig,
  QueueTransportConfig,
  BullMQTransportConfig,
  DbTransportConfig,
} from './transports/factory.js';
export {
  EventEmitterTransport,
  type EventEmitterTransportOptions,
} from './transports/event-emitter.js';
export { QueueTransport, type QueueTransportOptions } from './transports/queue.js';
export { DbTransport, type DbTransportOptions } from './transports/db.js';
export {
  BullMQTransport,
  type BullMQTransportOptions,
  type BullMQDeps,
  createBullMQDeps,
} from './transports/bullmq/index.js';
export {
  TRANSPORT_TABLES,
  createDurableTransportTables,
  dropDurableTransportTables,
} from './transports/db-schema.js';

// --- config-driven state-store drivers --------------------------------------
export { stores } from './stores/factory.js';
export type { StoreContext, StoreFactory, LucidStoreConfig } from './stores/factory.js';
export { LucidStateStore, type LucidStateStoreOptions } from './stores/lucid.js';
export { DURABLE_TABLES, createDurableTables, dropDurableTables } from './stores/lucid-schema.js';

// --- config-driven control-plane drivers ------------------------------------
export { controlPlanes } from './control-planes/factory.js';
export type {
  ControlPlaneContext,
  ControlPlaneFactory,
  RedisControlPlaneConfig,
} from './control-planes/factory.js';
export {
  type AdonisRedisPubSub,
  type IoredisPubSub,
  type IoredisSubscriber,
  RedisControlPlane,
  type RedisControlPlaneOptions,
  type RedisPubSub,
} from './control-plane-redis/redis-control-plane.js';

// --- AdonisJS integration ---------------------------------------------------
export { defineConfig } from './define_config.js';
export type { DurableConfig } from './define_config.js';
export type {
  StandaloneConfig,
  ControlPlaneConfig,
  TenantConfig,
  TenantVerifier,
  VerifiedTenant,
} from './config_types.js';

// --- store-less cluster: RunGateway (read/control surface) ------------------
export type { RunGateway, DurableTopology, StartRunOptions } from './run-gateway/interface.js';
export {
  StoreRunGateway,
  type RunGatewayEngine,
  type StoreRunGatewayOptions,
} from './run-gateway/store-run-gateway.js';
export {
  ProxyRunGateway,
  type ProxyTransport,
  type ProxyRunGatewayOptions,
} from './run-gateway/proxy-run-gateway.js';
export {
  RunRequestResponder,
  type ResponderTransport,
  type RunRequestResponderOptions,
} from './run-gateway/run-request-responder.js';
export { signTenantToken, hmacTenantVerifier } from './run-gateway/tenant-auth.js';

// --- store-less cluster: handshake & capability negotiation -----------------
export * from './handshake/descriptor.js';
export * from './handshake/negotiate.js';
export * from './handshake/routing.js';
export * from './dispatch-routing.js';

// Re-export the configure hook from the package root so `node ace configure` finds it.
// AdonisJS imports the package MAIN and reads `configure` off the module namespace —
// the `./configure` subpath alone is never consulted.
export { configure } from '../configure.js';

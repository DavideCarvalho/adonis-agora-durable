/**
 * One process of the two-process diagnostics delivery spec (`test/diagnostics/two-process.spec.ts`),
 * forked with `node --import ./test/support/register-diagnostics-node.mjs`. It boots the REAL
 * `@adonis-agora/diagnostics` provider with `default: 'durable'` against a durable engine on a real
 * Postgres store and a Redis control plane, the way an AdonisJS app wires the two:
 *
 * - `role: 'web'`: its engine never drives runs (`drive: false`); it emits events.
 * - `role: 'worker'`: it runs the worker loop (`node ace durable:work`).
 *
 * Both register the same listener, `TrackRun#handle`, which records each call in a table
 * ({@link CALLS_TABLE}) and throws on the first call for an event whose payload has `failFirst`.
 *
 * IPC in: `{ emit: payload }`, `{ deliver: { listenerId, envelope } }` (hand the transport one
 * delivery directly), `{ stop: true }`. IPC out: `{ ready }`, `{ heard: { type, runId } }` (engine
 * events this process received over Redis), `{ delivered }`, `{ error }`, `{ stopped }`.
 */
import { randomUUID } from 'node:crypto';
import { emit, onDiagnostic, transports } from '@adonis-agora/diagnostics';
import type { ListenerDelivery } from '@adonis-agora/diagnostics/delivery';
import DiagnosticsProvider from '@adonis-agora/diagnostics/diagnostics_provider';
import type { ApplicationService } from '@adonisjs/core/types';
import { Redis } from 'ioredis';
import { runWorkerLoop } from '../../src/commands/worker.js';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { DurableDeliveryTransport } from '../../src/diagnostics/index.js';
import { WorkflowEngine } from '../../src/engine.js';
import { NOOP_RUN_DISPATCHER } from '../../src/role_bindings.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { makePostgresDb } from '../../src/transports/db-helpers.js';
import { CALLS_TABLE, type NodeConfig } from './diagnostics-node-shared.js';

if (!process.env.DIAG_NODE || !process.send) {
  throw new Error('diagnostics-node.ts is a child-process entry point; set DIAG_NODE and fork it');
}
const config = JSON.parse(process.env.DIAG_NODE) as NodeConfig;
const send = (message: Record<string, unknown>) =>
  process.send?.({ name: config.name, ...message });

const db = makePostgresDb(config.pgUrl, config.schema);
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const controlPlane = new RedisControlPlane({ connection: redis, prefix: config.prefix });
const engine = new WorkflowEngine({
  store: new LucidStateStore(db),
  controlPlane,
  instanceId: config.name,
  namespace: 'default',
  ...(config.role === 'web' ? { runDispatcher: NOOP_RUN_DISPATCHER } : {}),
});
engine.subscribe((event) => {
  if (event.type.startsWith('run.')) send({ heard: { type: event.type, runId: event.runId } });
});

/** The app listener. Lazy ref form (`[Class, 'method']`), as a preload registers it. */
class TrackRun {
  async handle(event: { id?: string; payload: { failFirst?: boolean } }) {
    const id = String(event.id);
    const rows = (await db
      .connection()
      .from(CALLS_TABLE)
      .where('event_id', id)
      .count('* as count')) as Array<{ count: string | number }>;
    const attempt = Number(rows[0]?.count ?? 0) + 1;
    await db.connection().table(CALLS_TABLE).insert({ event_id: id, node: config.name, attempt });
    if (event.payload.failFirst && attempt === 1) throw new Error('first call fails');
  }
}
onDiagnostic('agent', 'run.finished', [TrackRun, 'handle']);

const logger = {
  error: (obj: unknown, msg?: string) => send({ error: `${msg ?? ''} ${String(obj)}` }),
  warn: () => {},
  info: () => {},
};
const diagnosticsConfig = {
  otel: false,
  listenersPath: false,
  nodeId: config.name,
  default: 'durable',
  transports: { durable: transports.durable({ retries: 3, backoffMs: 50 }) },
};
const app = {
  config: {
    get: (key: string, fallback: unknown) => (key === 'diagnostics' ? diagnosticsConfig : fallback),
  },
  container: {
    hasBinding: (binding: unknown) => binding === WorkflowEngine,
    make: async (binding: unknown) => {
      if (binding === WorkflowEngine) return engine;
      if (binding === 'logger') return logger;
      return new (binding as new () => object)();
    },
  },
  makePath: (...parts: string[]) => ['/nonexistent-app-root', ...parts].join('/'),
} as unknown as ApplicationService;

const provider = new DiagnosticsProvider(app);
await provider.boot();
await provider.ready();
// A second handle on the same engine, to hand over the same delivery more than once.
const direct = new DurableDeliveryTransport(engine);

let stopWorker: (() => void) | undefined;
let workerLoop: Promise<unknown> | undefined;
if (config.role === 'worker') {
  const stopSignal = new Promise<void>((resolve) => {
    stopWorker = resolve;
  });
  workerLoop = runWorkerLoop(engine, {
    intervalMs: 50,
    stopSignal,
    logger: { info: () => {}, error: (m) => send({ error: m }) },
  });
}

process.on('message', (raw) => {
  const message = raw as {
    emit?: Record<string, unknown>;
    deliver?: ListenerDelivery;
    stop?: boolean;
  };
  if (message.emit) emit('agent', 'run.finished', message.emit);
  if (message.deliver) {
    const delivery = message.deliver;
    direct
      .deliver([delivery])
      .then(() => send({ delivered: randomUUID() }))
      .catch((error: Error) => send({ error: `deliver: ${error.message}` }));
  }
  if (message.stop) {
    void (async () => {
      stopWorker?.();
      await workerLoop;
      await direct.stop();
      await provider.shutdown();
      await engine.drain(2_000).catch(() => undefined);
      await controlPlane.close().catch(() => undefined);
      redis.disconnect();
      await db.manager.closeAll();
      send({ stopped: true });
      process.exit(0);
    })();
  }
});

send({ ready: true });

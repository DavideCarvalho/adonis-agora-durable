/**
 * A worker PROCESS for the multi-process db transport scenarios (`db-multiprocess.spec.ts`), run by
 * plain `node --import ./test/support/register-ts.mjs` against the package sources. Configured by the
 * `DB_SCENARIO` env var (JSON, see {@link Config}); talks to its parent over the IPC channel.
 *
 * - `role: 'worker'` — a {@link DbTransport} serving {@link SCENARIO_STEP}. Every run of the step is
 *   recorded in {@link SCENARIO_RUNS_TABLE} (instance, in-flight slots, the row's `reclaims`) BEFORE
 *   the step body, so a run survives the process being killed mid-step. The step's input says what
 *   to do: `ms` to sleep (`msOn[instanceId]` overrides it), `die` to SIGKILL its own process.
 *   SIGTERM closes the transport (the deploy path: hand claims back) and exits 0.
 * - `role: 'schema'` — for every `{ go: schema }` message, run `createDurableTransportTables` on that
 *   schema and reply `{ done, ok, error? }`.
 */
import type { Database } from '@adonisjs/lucid/database';
import { DbTransport } from '../../src/transports/db.js';
import { makePostgresDb } from '../../src/transports/db-helpers.js';
import { createDurableTransportTables, TRANSPORT_TABLES } from '../../src/transports/db-schema.js';

export const SCENARIO_STEP = 'scenario.step';
export const SCENARIO_RUNS_TABLE = 'scenario_runs';

export interface Config {
  role: 'worker' | 'schema';
  url: string;
  schema: string;
  instanceId: string;
  concurrency?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  maxStalledCount?: number;
  closeTimeoutMs?: number;
}

export interface StepInput {
  seq: number;
  /** The dispatched task's stepId (handlers are not told it). */
  stepId: string;
  ms?: number;
  msOn?: Record<string, number>;
  die?: boolean;
}

const config = JSON.parse(process.env.DB_SCENARIO ?? '{}') as Config;
const send = (msg: unknown) => process.send?.(msg);

async function runWorker(): Promise<void> {
  const db: Database = makePostgresDb(config.url, config.schema);
  const transport = new DbTransport({
    db,
    instanceId: config.instanceId,
    pollIntervalMs: config.pollIntervalMs ?? 20,
    ...(config.concurrency === undefined ? {} : { concurrency: config.concurrency }),
    ...(config.leaseMs === undefined ? {} : { leaseMs: config.leaseMs }),
    ...(config.maxStalledCount === undefined ? {} : { maxStalledCount: config.maxStalledCount }),
    ...(config.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: config.closeTimeoutMs }),
    idleBackoffMax: 1,
    autoCreate: false,
    onError: () => {},
  });
  let inFlight = 0;
  transport.handle(SCENARIO_STEP, async (raw) => {
    const input = raw as StepInput;
    inFlight += 1;
    try {
      const [row] = await db
        .connection()
        .from(TRANSPORT_TABLES.tasks)
        .where('step_id', input.stepId)
        .select('reclaims');
      await db
        .connection()
        .table(SCENARIO_RUNS_TABLE)
        .insert({
          step_id: input.stepId,
          instance: config.instanceId,
          in_flight: inFlight,
          reclaims: Number(row?.reclaims ?? -1),
          at: Date.now(),
        });
      send({ started: input.stepId });
      if (input.die) process.kill(process.pid, 'SIGKILL');
      const ms = input.msOn?.[config.instanceId] ?? input.ms ?? 0;
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      return { seq: input.seq, by: config.instanceId };
    } finally {
      inFlight -= 1;
    }
  });
  process.on('SIGTERM', () => {
    void (async () => {
      await transport.close();
      await db.manager.closeAll();
      process.exit(0);
    })();
  });
  send({ ready: config.instanceId });
}

async function runSchema(): Promise<void> {
  process.on('message', (msg: { go?: string; exit?: boolean }) => {
    if (msg.exit) process.exit(0);
    if (!msg.go) return;
    const db = makePostgresDb(config.url, msg.go);
    createDurableTransportTables(db)
      .then(
        () => send({ done: msg.go, ok: true }),
        (err: unknown) => send({ done: msg.go, ok: false, error: String(err) }),
      )
      .finally(() => db.manager.closeAll());
  });
  send({ ready: config.instanceId });
}

await (config.role === 'schema' ? runSchema() : runWorker());

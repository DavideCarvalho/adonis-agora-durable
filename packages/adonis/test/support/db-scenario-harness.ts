import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Database } from '@adonisjs/lucid/database';
import { afterEach } from 'vitest';
import type { RemoteTask, StepResult } from '../../src/interfaces.js';
import { sanitizeQueueToken } from '../../src/tenant-group.js';
import { DbTransport } from '../../src/transports/db.js';
import { makeIsolatedPostgresDb } from '../../src/transports/db-helpers.js';
import { createDurableTransportTables } from '../../src/transports/db-schema.js';
import {
  type Config,
  SCENARIO_RUNS_TABLE,
  SCENARIO_STEP,
  type StepInput,
} from './db-scenario-worker.js';

/**
 * The harness of the multi-process db transport scenarios (`test/engine/transports/db-multiprocess-*`):
 * a fresh Postgres schema per test with the transport tables and the run log, an engine-side
 * transport in the test process, and worker PROCESSES (`db-scenario-worker.ts`) spawned against it.
 * Call {@link scenarioHarness} inside a `describe`: it registers the `afterEach` that SIGKILLs every
 * child still alive and drops the schema.
 */

const WORKER = fileURLToPath(new URL('./db-scenario-worker.ts', import.meta.url));
const REGISTER_TS = fileURLToPath(new URL('./register-ts.mjs', import.meta.url));
const TOKEN = sanitizeQueueToken(SCENARIO_STEP);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(
  cond: () => boolean | Promise<boolean>,
  budgetMs: number,
  label = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

export interface Child {
  proc: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  messages: Array<Record<string, unknown>>;
}

/** One run of the step, as the worker recorded it before the step body. */
export interface RunRow {
  step_id: string;
  instance: string;
  in_flight: number;
  reclaims: number;
  at: string | number;
}

export function runsPerStep(rows: RunRow[]): Map<string, number> {
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.step_id, (per.get(r.step_id) ?? 0) + 1);
  return per;
}

export const distinctResults = (results: StepResult[]) =>
  new Set(results.map((r) => r.stepId)).size;

export const task = (
  seq: number,
  input: Omit<StepInput, 'seq' | 'stepId'> = {},
  priority?: number,
) =>
  ({
    runId: 'r1',
    seq,
    stepId: `r1:${seq}`,
    name: SCENARIO_STEP,
    group: TOKEN,
    input: { seq, stepId: `r1:${seq}`, ...input } satisfies StepInput,
    attempt: 1,
    ...(priority === undefined ? {} : { priority }),
  }) as RemoteTask;

export function scenarioHarness(pgUrl: string) {
  const children: Child[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  let db: (Database & { schemaName: string }) | undefined;

  afterEach(async () => {
    for (const c of children.splice(0)) {
      if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill('SIGKILL');
      await c.exited;
    }
    for (const c of cleanups.splice(0).reverse()) await c();
    db = undefined;
  });

  const current = () => {
    if (!db) throw new Error('call setup() or emptyDb() first');
    return db;
  };

  /** A fresh, empty schema (dropped after the test). */
  async function emptyDb() {
    const fresh = await makeIsolatedPostgresDb(pgUrl);
    db = fresh;
    cleanups.push(() => fresh.manager.closeAll());
    return fresh;
  }

  /** A fresh schema with the transport tables and the run log, and an engine-side transport on it. */
  async function setup() {
    const fresh = await emptyDb();
    await createDurableTransportTables(fresh);
    await fresh.connection().schema.createTable(SCENARIO_RUNS_TABLE, (t) => {
      t.increments('id');
      t.string('step_id').notNullable();
      t.string('instance').notNullable();
      t.integer('in_flight').notNullable();
      t.integer('reclaims').notNullable();
      t.bigInteger('at').notNullable();
    });
    const engine = new DbTransport({ db: fresh, instanceId: 'engine', pollIntervalMs: 20 });
    cleanups.push(() => engine.close());
    const results: StepResult[] = [];
    engine.onResult(async (r) => void results.push(r));
    return { db: fresh, engine, results };
  }

  /** Fork a worker process on the current schema. */
  function spawn(config: Omit<Config, 'url' | 'schema'>): Child {
    const proc = fork(WORKER, [], {
      execArgv: ['--import', REGISTER_TS],
      env: {
        ...process.env,
        DB_SCENARIO: JSON.stringify({ ...config, url: pgUrl, schema: current().schemaName }),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const messages: Array<Record<string, unknown>> = [];
    proc.on('message', (m) => messages.push(m as Record<string, unknown>));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const child = { proc, exited, messages };
    children.push(child);
    return child;
  }

  /** {@link spawn}, resolved once the worker is consuming. */
  async function spawnReady(config: Omit<Config, 'url' | 'schema'>): Promise<Child> {
    const child = spawn(config);
    await until(() => child.messages.some((m) => m.ready), 15_000, `${config.instanceId} ready`);
    return child;
  }

  /** Every recorded run, in order. */
  const runs = async (): Promise<RunRow[]> =>
    current().connection().from(SCENARIO_RUNS_TABLE).orderBy('id').select('*');

  return { setup, emptyDb, spawn, spawnReady, runs, cleanups };
}

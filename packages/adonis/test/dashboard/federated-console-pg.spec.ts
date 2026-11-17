import { Emitter } from '@adonisjs/core/events';
import { Logger } from '@adonisjs/core/logger';
import { Database } from '@adonisjs/lucid/database';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { answerConsoleCommands, FederatedApp } from '../../src/dashboard/federation.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { cancelRun, getRun, listRuns, signalRun } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { ControlPlane } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { startRun } from '../../src/test-helpers.js';
import { postgresTestSchemaPrefix } from '../../src/transports/db-helpers.js';
import { backendUrl, uniqueRedisPrefix } from '../support/backends.js';
import { consoleBus } from '../support/console-bus.js';

/**
 * The federated console end to end on Postgres: two apps share one database, each with its durable
 * tables in its own schema and its own engine. The console app reads the other app's schema through
 * a role that can only SELECT there (the GRANTs the docs ask for), and every action reaches the
 * other app's engine over its control plane (a real Redis when one is configured).
 */
const PG_URL = backendUrl('DURABLE_PG_URL');
const REDIS_URL = process.env.REDIS_URL;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);

function database(url: string): Database {
  return new Database(
    {
      connection: 'pg',
      connections: {
        pg: { client: 'pg', connection: { connectionString: url }, pool: { min: 0, max: 3 } },
      },
    },
    new Logger({ enabled: false }),
    new Emitter(undefined as never),
  );
}

async function until(check: () => Promise<boolean>, budgetMs = 10_000) {
  const deadline = Date.now() + budgetMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await delay(20);
  }
}

describe.skipIf(!PG_URL)('federated console on Postgres (two schemas)', () => {
  const schemaA = `${postgresTestSchemaPrefix()}fa_${process.pid}_${rand()}`;
  const schemaB = `${postgresTestSchemaPrefix()}fb_${process.pid}_${rand()}`;
  const role = `durable_fed_ro_${process.pid}_${rand()}`;
  const prefix = uniqueRedisPrefix('fed');
  let admin: Database;
  let readOnly: Database;
  let engineA: WorkflowEngine;
  let engineB: WorkflowEngine;
  let app: FederatedApp;
  const closers: Array<() => Promise<unknown> | unknown> = [];

  function plane(): ControlPlane & { close?: () => Promise<void> } {
    if (!REDIS_URL) return bus.plane();
    const client = new Redis(REDIS_URL);
    closers.push(() => client.disconnect());
    const p = new RedisControlPlane({ connection: client, prefix, pingIntervalMs: 0 });
    closers.push(() => p.close());
    return p;
  }
  const bus = consoleBus();

  beforeAll(async () => {
    admin = database(PG_URL as string);
    const storeA = new LucidStateStore(admin, { schema: schemaA });
    const storeB = new LucidStateStore(admin, { schema: schemaB });
    await storeA.ensureSchema();
    await storeB.ensureSchema();

    // The console's role: read-only on the other app's schema, nothing else.
    await admin.rawQuery(`create role ${role} login password 'ro'`);
    await admin.rawQuery(`grant usage on schema ${schemaB} to ${role}`);
    await admin.rawQuery(`grant select on all tables in schema ${schemaB} to ${role}`);
    const url = new URL(PG_URL as string);
    url.username = role;
    url.password = 'ro';
    readOnly = database(url.toString());

    engineA = new WorkflowEngine({ store: storeA, instanceId: 'console-app' });
    engineA.register('report', '1', async () => 'done');

    const ownerPlane = plane();
    engineB = new WorkflowEngine({ store: storeB, controlPlane: ownerPlane, instanceId: 'owner' });
    engineB.register('approval', '1', async (ctx) => {
      await ctx.localStep('prepare', async () => ({ prepared: true }));
      return ctx.waitForSignal('approve');
    });
    answerConsoleCommands(ownerPlane, storeDashboardEngine(engineB));

    app = new FederatedApp({
      id: 'b',
      store: new LucidStateStore(readOnly, { schema: schemaB }),
      controlPlane: plane(),
    });
    if (REDIS_URL) {
      const probe = new Redis(REDIS_URL);
      closers.push(() => probe.disconnect());
      for (;;) {
        const [, n] = (await probe.pubsub('NUMSUB', `${prefix}-console`)) as [string, number];
        if (Number(n) >= 1) break;
        await delay(10);
      }
    }
  });

  afterAll(async () => {
    for (const close of closers.reverse()) await close();
    await readOnly?.manager.closeAll();
    for (const schema of [schemaA, schemaB]) {
      await admin.rawQuery('drop schema if exists ?? cascade', [schema]).catch(() => {});
    }
    await admin.rawQuery(`drop role if exists ${role}`).catch(() => {});
    await admin?.manager.closeAll();
  });

  it('lists only the other app’s runs, read through the read-only role', async () => {
    await startRun(engineA, 'report', {}, 'a-1');
    await startRun(engineB, 'approval', { order: 7 }, 'b-1');
    const deps = { engine: app.engine('ops') };

    const list = await listRuns(deps, { params: {}, query: {} });
    expect(list.status).toBe(200);
    const rows = (list.body as { data: Array<{ id: string; status: string }> }).data;
    expect(rows.map((r) => [r.id, r.status])).toEqual([['b-1', 'suspended']]);

    const detail = await getRun(deps, { params: { id: 'b-1' }, query: {} });
    expect(detail.status).toBe(200);
    const body = detail.body as { run: { input: unknown }; timeline: Array<{ name: string }> };
    expect(body.run.input).toEqual({ order: 7 });
    expect(body.timeline.map((s) => s.name)).toContain('prepare');
  });

  it('cannot write through the read-only role', async () => {
    const store = new LucidStateStore(readOnly, { schema: schemaB });
    await expect(store.updateRun('b-1', { status: 'failed' })).rejects.toThrow(/permission denied/);
  });

  it('acts through the owning engine: signal resumes, cancel cancels', async () => {
    const deps = { engine: app.engine('ops') };
    const signalled = await signalRun(deps, {
      params: { id: 'b-1' },
      query: {},
      body: { token: 'approve', payload: 'yes' },
    });
    expect(signalled.status).toBe(200);
    await until(async () => (await engineB.getRun('b-1'))?.status === 'completed');

    await startRun(engineB, 'approval', {}, 'b-2');
    const cancelled = await cancelRun(deps, { params: { id: 'b-2' }, query: {} });
    expect(cancelled.status).toBe(200);
    expect((await engineB.getRun('b-2'))?.status).toBe('cancelled');
    // The console app's own runs are untouched.
    expect((await engineA.getRun('a-1'))?.status).toBe('completed');
  });
});

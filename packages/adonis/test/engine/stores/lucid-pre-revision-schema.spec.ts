import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import type { WorkflowRun } from '../../../src/interfaces.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { makeStoreDb } from '../../../src/stores/lucid-helpers.js';
import { DURABLE_TABLES } from '../../../src/stores/lucid-schema.js';

/**
 * `autoSchema: false` with a migration from before remote workflows: the runs table has no
 * `awaiting_decision_task_id`. Creating a run already leaves the column out; the patches that CLEAR
 * the marker (cancel, requeue, settle) must too, instead of failing with "no such column".
 */
async function preRevisionDb(): Promise<Database> {
  const db = await makeStoreDb();
  await db.connection().schema.alterTable(DURABLE_TABLES.runs, (t) => {
    t.dropColumn('awaiting_decision_task_id');
  });
  return db;
}

const run = (id: string): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'suspended',
  input: {},
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('Lucid store on a schema without awaiting_decision_task_id', () => {
  const dbs: Database[] = [];
  afterEach(async () => {
    for (const db of dbs.splice(0)) await db.manager.closeAll();
  });

  it('updateRun / updateRunIf clearing the decision marker succeed', async () => {
    const db = await preRevisionDb();
    dbs.push(db);
    const store = new LucidStateStore(db);
    await store.createRun(run('r1'));
    await store.updateRun('r1', { status: 'pending', awaitingDecisionTaskId: undefined });
    expect((await store.getRun('r1'))?.status).toBe('pending');
    expect(
      await store.updateRunIf('r1', ['pending'], {
        status: 'cancelled',
        awaitingDecisionTaskId: undefined,
      }),
    ).toBe(true);
    expect((await store.getRun('r1'))?.status).toBe('cancelled');
  });

  it('engine.cancel of a suspended run works end to end', async () => {
    const db = await preRevisionDb();
    dbs.push(db);
    const store = new LucidStateStore(db);
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => ctx.waitForSignal('never'));
    await engine.start('wf', {}, 'r2');
    await engine.waitForRun('r2', { timeoutMs: 2000 }).catch(() => undefined);
    await engine.cancel('r2');
    expect((await store.getRun('r2'))?.status).toBe('cancelled');
  });

  it('still writes the marker where the column exists', async () => {
    const db = await makeStoreDb();
    dbs.push(db);
    const store = new LucidStateStore(db);
    await store.createRun(run('r3'));
    await store.updateRun('r3', { awaitingDecisionTaskId: 't1' });
    expect((await store.getRun('r3'))?.awaitingDecisionTaskId).toBe('t1');
    await store.updateRun('r3', { awaitingDecisionTaskId: undefined });
    expect((await store.getRun('r3'))?.awaitingDecisionTaskId).toBeUndefined();
  });
});

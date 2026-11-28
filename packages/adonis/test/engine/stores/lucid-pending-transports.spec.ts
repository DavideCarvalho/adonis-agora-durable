import { describe, expect, it } from 'vitest';
import type { StepCheckpoint, WorkflowRun } from '../../../src/interfaces.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { DURABLE_TABLES } from '../../../src/stores/lucid-schema.js';
import { dbBackends } from '../../support/backends.js';

/**
 * A step pinned to a transport built on demand records the transport on its checkpoint, and an
 * engine restarting reads which of those transports a `pending` step still names, to build them.
 */

const at = new Date('2026-11-28T00:00:00.000Z');
const run = (id: string): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'suspended',
  input: {},
  createdAt: at,
  updatedAt: at,
});
const checkpoint = (
  runId: string,
  seq: number,
  status: StepCheckpoint['status'],
  transport?: string,
): StepCheckpoint => ({
  runId,
  seq,
  name: 'ext.ping',
  kind: 'remote',
  stepId: `${runId}:${seq}`,
  status,
  attempts: 1,
  ...(transport !== undefined ? { transport } : {}),
  enqueuedAt: at,
  startedAt: at,
  finishedAt: at,
});

describe.each(dbBackends({ mysql: true }))('listPendingTransports on $name', (b) => {
  it('names the transports a pending checkpoint still names, and reads the pin back', async () => {
    const db = await b.makeStoreDb();
    try {
      const store = new LucidStateStore(db);
      await store.createRun(run('r1'));
      await store.saveCheckpoint(checkpoint('r1', 0, 'pending', 'db'));
      await store.saveCheckpoint(checkpoint('r1', 1, 'completed', 'bull'));
      await store.saveCheckpoint(checkpoint('r1', 2, 'pending'));
      expect(await store.insertCheckpointIfAbsent(checkpoint('r1', 3, 'pending', 'sqs'))).toBe(
        true,
      );
      await store.saveCheckpoints([checkpoint('r1', 4, 'pending', 'db')]);

      expect((await store.listPendingTransports(['db', 'bull', 'sqs', 'kafka'])).sort()).toEqual([
        'db',
        'sqs',
      ]);
      expect(await store.listPendingTransports([])).toEqual([]);
      expect((await store.getCheckpoint('r1', 0))?.transport).toBe('db');
      expect((await store.listCheckpoints('r1')).map((cp) => cp.transport)).toEqual([
        'db',
        'bull',
        undefined,
        'sqs',
        'db',
      ]);

      // Settled, the step no longer waits on the transport.
      await store.settleCheckpointsIfPending([
        { runId: 'r1', seq: 0, status: 'completed', startedAt: at, finishedAt: at },
        { runId: 'r1', seq: 4, status: 'completed', startedAt: at, finishedAt: at },
      ]);
      expect(await store.listPendingTransports(['db', 'sqs'])).toEqual(['sqs']);
    } finally {
      await db.manager.closeAll();
    }
  });

  it('an unpinned step writes on a schema without the column', async () => {
    const db = await b.makeStoreDb();
    try {
      await db.connection().schema.alterTable(DURABLE_TABLES.checkpoints, (t) => {
        t.dropIndex(['transport', 'status'], 'durable_step_checkpoints_transport_idx');
      });
      await db.connection().schema.alterTable(DURABLE_TABLES.checkpoints, (t) => {
        t.dropColumn('transport');
      });
      const store = new LucidStateStore(db);
      await store.createRun(run('r1'));
      await store.saveCheckpoint(checkpoint('r1', 0, 'pending'));
      expect((await store.getCheckpoint('r1', 0))?.status).toBe('pending');
      await expect(store.listPendingTransports(['db'])).rejects.toThrow();
    } finally {
      await db.manager.closeAll();
    }
  });
});

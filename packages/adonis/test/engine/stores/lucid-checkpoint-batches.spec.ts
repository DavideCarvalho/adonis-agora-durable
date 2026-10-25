import type { Database } from '@adonisjs/lucid/database';
import { describe, expect, it } from 'vitest';
import type { StepCheckpoint } from '../../../src/interfaces.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { dbBackends } from '../../support/backends.js';

/**
 * A wide step fan's checkpoints cost the Lucid store a few statements per batch, not one per row:
 * writing its pending rows, reading a batch of them back, and settling a batch of results.
 */

async function countQueries(db: Database, fn: () => Promise<void>): Promise<string[]> {
  const sql: string[] = [];
  const clients = new Set([db.connection().getWriteClient(), db.connection().getReadClient()]);
  const listener = (q: { sql: string }) => sql.push(q.sql);
  for (const client of clients) client.on('query', listener);
  try {
    await fn();
  } finally {
    for (const client of clients) client.off('query', listener);
  }
  return sql;
}

const at = new Date('2026-06-11T00:00:00.000Z');
const ROWS = 600;
const cp = (seq: number, over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
  runId: 'r1',
  seq,
  name: 'lines.process',
  kind: 'remote',
  stepId: `r1:${seq}`,
  status: 'pending',
  attempts: 1,
  enqueuedAt: at,
  startedAt: at,
  finishedAt: at,
  ...over,
});
const seqs = Array.from({ length: ROWS }, (_, i) => i);

describe.each(dbBackends({ mysql: true }))('on $name', ({ makeStoreDb }) => {
  it(`writes, reads and settles ${ROWS} checkpoints in a few dozen statements`, async () => {
    const db = await makeStoreDb();
    try {
      const store = new LucidStateStore(db);
      await store.createRun({
        id: 'r1',
        workflow: 'fan',
        workflowVersion: '1',
        status: 'running',
        input: null,
        createdAt: at,
        updatedAt: at,
      });
      // Warm the schema check, so it is not counted against the first call.
      await store.getCheckpoint('r1', 0);

      const wrote = await countQueries(db, () => store.saveCheckpoints(seqs.map((s) => cp(s))));
      expect(await store.listCheckpoints('r1')).toHaveLength(ROWS);
      const read = await countQueries(db, async () => {
        expect(await store.getCheckpoints('r1', seqs)).toHaveLength(ROWS);
      });
      const settled = await countQueries(db, async () => {
        const done = await store.saveCheckpointsIfPending(
          seqs.map((s) => cp(s, { status: 'completed', output: { n: s } })),
        );
        expect(done.every(Boolean)).toBe(true);
      });
      expect((await store.getCheckpoint('r1', ROWS - 1))?.output).toEqual({ n: ROWS - 1 });

      // One statement per row would be 600+ each.
      for (const sql of [wrote, read, settled]) expect(sql.length).toBeGreaterThan(0);
      expect(wrote.length).toBeLessThanOrEqual(30);
      expect(read.length).toBeLessThanOrEqual(30);
      expect(settled.length).toBeLessThanOrEqual(30);
    } finally {
      await db.manager.closeAll();
    }
  }, 60_000);
});

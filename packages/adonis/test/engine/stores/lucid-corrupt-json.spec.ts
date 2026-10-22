import type { Database } from '@adonisjs/lucid/database';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { makeStoreDb } from '../../../src/stores/lucid-helpers.js';
import { type CorruptJsonColumn, onCorruptJsonColumn } from '../../../src/stores/lucid-mappers.js';
import { DURABLE_TABLES } from '../../../src/stores/lucid-schema.js';
import { InMemoryTransport } from '../../../src/testing/in-memory-transport.js';

/**
 * A JSON column that does not parse — a MySQL `text` value cut off at 64KB before the schema used
 * `longtext`, or a row edited by hand — used to throw out of the row mapper. That failed every read
 * touching the row: `listRuns` (the dashboard's run list, for EVERY run on the page), the run detail,
 * and the replay of the run. Now the bad field reads back as `undefined`, the rest of the row and
 * every other row read normally, and the damage is reported once per row and column.
 */

const at = new Date('2026-06-11T00:00:00.000Z');
const TRUNCATED = '{"lines":[{"id":1,"text":"cut off mid-stri';

describe('LucidStateStore tolerates a JSON column that does not parse', () => {
  const open: Database[] = [];
  const reports: CorruptJsonColumn[] = [];
  let restore: ((info: CorruptJsonColumn) => void) | undefined;
  beforeEach(() => {
    const previous = onCorruptJsonColumn((info) => reports.push(info));
    restore ??= previous;
  });
  afterEach(async () => {
    reports.length = 0;
    while (open.length) await open.pop()?.manager.closeAll();
  });
  afterAll(() => {
    if (restore) onCorruptJsonColumn(restore);
  });

  async function seeded() {
    const db = await makeStoreDb();
    open.push(db);
    const store = new LucidStateStore(db);
    for (const id of ['good', 'bad']) {
      await store.createRun({
        id,
        workflow: 'import',
        workflowVersion: '1',
        status: 'completed',
        input: { file: `${id}.csv` },
        output: { rows: 3 },
        tags: ['etl'],
        createdAt: at,
        updatedAt: at,
      });
      await store.saveCheckpoint({
        runId: id,
        seq: 0,
        name: 'parse',
        kind: 'local',
        stepId: `${id}:0`,
        status: 'completed',
        output: { rows: 3 },
        events: [{ type: 'log', at: at.toISOString(), message: 'ok' }] as never,
        attempts: 1,
        enqueuedAt: at,
        startedAt: at,
        finishedAt: at,
      });
    }
    // Damage the `bad` run's output and its checkpoint's events, as a truncating write would.
    await db.from(DURABLE_TABLES.runs).where('id', 'bad').update({ output: TRUNCATED });
    await db
      .from(DURABLE_TABLES.checkpoints)
      .where('run_id', 'bad')
      .update({ events: TRUNCATED, output: TRUNCATED });
    return { db, store };
  }

  it('lists every run, with the damaged field read back as undefined', async () => {
    const { store } = await seeded();
    const runs = await store.listRuns({});
    expect(runs.map((r) => r.id).sort()).toEqual(['bad', 'good']);
    const bad = runs.find((r) => r.id === 'bad');
    expect(bad?.output).toBeUndefined();
    // The rest of the row is intact.
    expect(bad?.input).toEqual({ file: 'bad.csv' });
    expect(bad?.tags).toEqual(['etl']);
    expect(runs.find((r) => r.id === 'good')?.output).toEqual({ rows: 3 });
  });

  it('reads the damaged run and its checkpoints, and reports each bad column once', async () => {
    const { store } = await seeded();
    expect((await store.getRun('bad'))?.output).toBeUndefined();
    const [cp] = await store.listCheckpoints('bad');
    expect(cp?.status).toBe('completed');
    expect(cp?.events).toBeUndefined();
    expect(cp?.output).toBeUndefined();
    // Read again (a dashboard polls): no second report.
    await store.getRun('bad');
    await store.listCheckpoints('bad');
    expect(reports.map((r) => `${r.column} ${r.row}`).sort()).toEqual([
      `${DURABLE_TABLES.checkpoints}.events bad#0`,
      `${DURABLE_TABLES.checkpoints}.output bad#0`,
      `${DURABLE_TABLES.runs}.output bad`,
    ]);
    expect(reports[0]?.message).toMatch(/JSON/);
  });

  it("serves the run detail of the damaged run and doesn't touch the others", async () => {
    const { store } = await seeded();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const detail = await engine.getRunDetail('bad', { summarizeFansOver: 50 });
    expect(detail?.run.id).toBe('bad');
    expect(detail?.timeline).toHaveLength(1);
    expect((await engine.getRunDetail('good'))?.timeline[0]?.output).toEqual({ rows: 3 });
  });

  it('degrades a buffered payload and a schedule document the same way', async () => {
    const { db, store } = await seeded();
    await store.bufferEvent({ id: 'e1', name: 'order', payload: { a: 1 }, publishedAt: 1 });
    await db.from(DURABLE_TABLES.bufferedEvents).where('id', 'e1').update({ payload: TRUNCATED });
    expect(await store.listBufferedEvents('order', 10)).toEqual([
      { id: 'e1', payload: undefined, publishedAt: 1 },
    ]);
    await store.bufferSignal('sig', { a: 1 });
    await db
      .from(DURABLE_TABLES.bufferedSignals)
      .where('token', 'sig')
      .update({ payload: TRUNCATED });
    expect(await store.takeBufferedSignal('sig')).toEqual({ payload: undefined });
  });
});

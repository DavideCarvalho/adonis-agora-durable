import type { Database } from '@adonisjs/lucid/database';
import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../src/interfaces.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { dbBackends } from '../../support/backends.js';

/**
 * What a run's lifecycle costs the Lucid store per call: a write that is one statement is not wrapped
 * in a transaction, and a take that finds nothing is one read. A run of one step makes each of these
 * calls once or twice, so their round trips bound how many such runs a pool can carry.
 */

async function statements(db: Database, fn: () => Promise<unknown>): Promise<string[]> {
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

const opensTransaction = (sql: string[]) => sql.some((q) => /^(begin|start transaction)/i.test(q));

const at = new Date('2026-10-27T00:00:00.000Z');
const run = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: 'job',
  workflowVersion: '1',
  status: 'pending',
  input: { n: 1 },
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe.each(dbBackends({ mysql: true }))('on $name', ({ makeStoreDb }) => {
  async function store() {
    const db = await makeStoreDb();
    const s = new LucidStateStore(db);
    // Warm the column probes, so they are not counted against the first call.
    await s.createRun(run('warm'));
    await s.updateRun('warm', { status: 'running', updatedAt: at });
    await s.updateRunIf('warm', ['running'], { status: 'suspended', updatedAt: at });
    return { db, s };
  }

  it('creates a run without search attributes in two statements and no transaction', async () => {
    const { db, s } = await store();
    try {
      const sql = await statements(db, () => s.createRun(run('r1')));
      expect(opensTransaction(sql)).toBe(false);
      expect(sql).toHaveLength(2);
      expect((await s.getRun('r1'))?.status).toBe('pending');
    } finally {
      await db.manager.closeAll();
    }
  });

  it('a duplicate run id is rejected and leaves the existing run and its attributes', async () => {
    const { db, s } = await store();
    try {
      await s.createRun(run('r1', { searchAttributes: { customer: 'acme' } }));
      await expect(s.createRun(run('r1', { input: { n: 2 } }))).rejects.toThrow();
      const kept = await s.getRun('r1');
      expect(kept?.input).toEqual({ n: 1 });
      expect(kept?.searchAttributes).toEqual({ customer: 'acme' });
    } finally {
      await db.manager.closeAll();
    }
  });

  it('a run with search attributes is still created in one transaction', async () => {
    const { db, s } = await store();
    try {
      const sql = await statements(db, () =>
        s.createRun(run('r1', { searchAttributes: { customer: 'acme' } })),
      );
      expect(opensTransaction(sql)).toBe(true);
      expect((await s.getRun('r1'))?.searchAttributes).toEqual({ customer: 'acme' });
    } finally {
      await db.manager.closeAll();
    }
  });

  it('a non-terminal status change is one UPDATE without a transaction', async () => {
    const { db, s } = await store();
    try {
      await s.createRun(run('r1'));
      const started = await statements(db, () =>
        s.updateRun('r1', { status: 'running', updatedAt: at }),
      );
      const suspended = await statements(db, async () => {
        expect(await s.updateRunIf('r1', ['running'], { status: 'suspended', updatedAt: at })).toBe(
          true,
        );
      });
      for (const sql of [started, suspended]) {
        expect(opensTransaction(sql)).toBe(false);
        expect(sql).toHaveLength(1);
      }
      expect(await s.updateRunIf('r1', ['running'], { status: 'pending', updatedAt: at })).toBe(
        false,
      );
      expect((await s.getRun('r1'))?.status).toBe('suspended');
    } finally {
      await db.manager.closeAll();
    }
  });

  it('a terminal settle still runs in a transaction', async () => {
    const { db, s } = await store();
    try {
      await s.createRun(run('r1', { status: 'running' }));
      const sql = await statements(db, () =>
        s.updateRun('r1', { status: 'completed', output: 1, updatedAt: at }),
      );
      expect(opensTransaction(sql)).toBe(true);
      expect((await s.getRun('r1'))?.status).toBe('completed');
    } finally {
      await db.manager.closeAll();
    }
  });

  it('taking a buffered signal or a waiter that is not there is one read', async () => {
    const { db, s } = await store();
    try {
      const signal = await statements(db, async () => {
        expect(await s.takeBufferedSignal('cancel:r1')).toBeNull();
      });
      const waiter = await statements(db, async () => {
        expect(await s.takeSignalWaiter('child:r1')).toBeNull();
      });
      expect(signal).toHaveLength(1);
      expect(waiter).toHaveLength(1);
    } finally {
      await db.manager.closeAll();
    }
  });

  it('takes buffered signals oldest first, each by one taker only', async () => {
    const { db, s } = await store();
    try {
      await s.bufferSignal('t', { n: 1 });
      await s.bufferSignal('t', { n: 2 });
      const [a, b] = await Promise.all([s.takeBufferedSignal('t'), s.takeBufferedSignal('t')]);
      const taken = [a, b].filter((x) => x !== null).map((x) => x?.payload);
      // Two racing takers never get the same signal.
      expect(new Set(taken.map((p) => JSON.stringify(p))).size).toBe(taken.length);
      const rest: unknown[] = [];
      for (let next = await s.takeBufferedSignal('t'); next; next = await s.takeBufferedSignal('t'))
        rest.push(next.payload);
      expect([...taken, ...rest].map((p) => (p as { n: number }).n).sort()).toEqual([1, 2]);
    } finally {
      await db.manager.closeAll();
    }
  });

  it('hands a signal waiter to one of two racing takers', async () => {
    const { db, s } = await store();
    try {
      await s.putSignalWaiter({ token: 'child:c1', runId: 'p', seq: 3 });
      const taken = await Promise.all([
        s.takeSignalWaiter('child:c1'),
        s.takeSignalWaiter('child:c1'),
      ]);
      expect(taken.filter((w) => w !== null)).toEqual([
        expect.objectContaining({ token: 'child:c1', runId: 'p', seq: 3 }),
      ]);
      expect(await s.takeSignalWaiter('child:c1')).toBeNull();
    } finally {
      await db.manager.closeAll();
    }
  });
});

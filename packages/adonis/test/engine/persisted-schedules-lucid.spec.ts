import { describe, expect, it } from 'vitest';
import { runTick } from '../../src/commands/worker.js';
import { WorkflowEngine } from '../../src/engine.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { makeStoreDb } from '../../src/stores/lucid-helpers.js';

const T0 = Date.parse('2026-03-02T00:00:00.000Z');
const MIN = 60_000;

describe('persisted schedules on Lucid, fired by the worker tick', () => {
  it('fires due schedules only when persistedSchedules is on, once per window across engines', async () => {
    const db = await makeStoreDb();
    try {
      const store = new LucidStateStore(db);
      const make = (persistedSchedules: boolean) => {
        const engine = new WorkflowEngine({ store, clock: () => T0, persistedSchedules });
        engine.register('job', '1', async (_ctx, input) => input);
        return engine;
      };
      const off = make(false);
      const a = make(true);
      const b = make(true);
      await a.schedules.create({
        id: 'every-minute',
        workflow: 'job',
        input: { n: 1 },
        every: '1m',
        tags: ['tenant:x'],
      });

      expect((await runTick(off, { now: T0 + MIN })).scheduled).toBe(0);
      const [ta, tb] = await Promise.all([
        runTick(a, { now: T0 + MIN }),
        runTick(b, { now: T0 + MIN }),
      ]);
      expect(ta.errors).toEqual([]);
      expect(tb.errors).toEqual([]);
      const runs = await store.listRuns({ tag: 'schedule:every-minute' });
      expect(runs.map((r) => r.id)).toEqual([`sched:every-minute:${T0 + MIN}`]);
      expect(runs[0]?.tags).toEqual(['tenant:x', 'schedule:every-minute']);
      const s = await a.schedules.get('every-minute');
      expect(s?.fires).toBe(1);
      expect(s?.nextFireAt?.getTime()).toBe(T0 + 2 * MIN);
      await Promise.all([off.drain(), a.drain(), b.drain()]);
    } finally {
      await db.manager.closeAll();
    }
  });
});

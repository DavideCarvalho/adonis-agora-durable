import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { makeStoreDb } from '../../../src/stores/lucid-helpers.js';

/**
 * Drive a real `WorkflowEngine` over the Lucid store and run end-to-end workflows — the strongest
 * proof the store satisfies the engine's actual durability requirements (the same outcomes the core
 * engine specs assert with the in-memory store).
 */

let db: Database;
let store: LucidStateStore;

beforeEach(async () => {
  db = await makeStoreDb();
  store = new LucidStateStore(db);
});

afterEach(async () => {
  await db.manager.closeAll();
});

describe('WorkflowEngine over LucidStateStore', () => {
  it('runs a single-step workflow to completion', async () => {
    const engine = new WorkflowEngine({ store });
    engine.register('greet', '1', async (ctx) => {
      const a = await ctx.localStep('a', async () => 21);
      return a * 2;
    });
    await engine.start('greet', {}, 'run-1');
    const result = await engine.waitForRun('run-1');
    expect(result.status).toBe('completed');
    expect(result.output).toBe(42);

    // The run + its checkpoint are durably persisted.
    expect((await store.getRun('run-1'))?.status).toBe('completed');
    expect((await store.listCheckpoints('run-1')).length).toBeGreaterThanOrEqual(1);
  });

  it('runs a multi-step workflow, persisting each checkpoint', async () => {
    const engine = new WorkflowEngine({ store });
    engine.register('pipe', '1', async (ctx) => {
      const a = await ctx.localStep('a', async () => 10);
      const b = await ctx.localStep('b', async () => a + 5);
      const c = await ctx.localStep('c', async () => b * 2);
      return c;
    });
    await engine.start('pipe', {}, 'run-2');
    const result = await engine.waitForRun('run-2');
    expect(result.status).toBe('completed');
    expect(result.output).toBe(30);
    const cps = await store.listCheckpoints('run-2');
    const names = cps.filter((c) => c.status === 'completed').map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('resumes after a failure WITHOUT re-running completed steps (durable replay)', async () => {
    const engine = new WorkflowEngine({ store });
    let aRuns = 0;
    let failOnce = true;
    engine.register('wf', '1', async (c) => {
      const a = await c.localStep('a', async () => {
        aRuns += 1;
        return 10;
      });
      return c.localStep('b', async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return a + 5;
      });
    });
    await engine.start('wf', { x: 1 }, 'run-3');
    expect((await engine.waitForRun('run-3')).status).toBe('failed');

    const resumed = await engine.resume('run-3');
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe(15);
    // 'a' completed before the failure, so replay returns its checkpoint — it must NOT re-run.
    expect(aRuns).toBe(1);
  });

  it('suspends on a durable sleep and resumes once the timer is due', async () => {
    let now = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => now });
    const order: string[] = [];
    engine.register('wf', '1', async (ctx) => {
      await ctx.localStep('before', async () => {
        order.push('before');
      });
      await ctx.sleep('10s');
      await ctx.localStep('after', async () => {
        order.push('after');
      });
      return 'done';
    });

    await engine.start('wf', {}, 'run-4');
    expect((await engine.waitForRun('run-4')).status).toBe('suspended');
    expect(order).toEqual(['before']);
    expect((await store.getRun('run-4'))?.status).toBe('suspended');

    // Not due yet — stays suspended (listDueTimers must not return it).
    now = 5_000;
    await engine.resumeDueTimers(now);
    expect((await store.getRun('run-4'))?.status).toBe('suspended');
    expect(order).toEqual(['before']);

    // Due — resumes, replays 'before', runs 'after', completes.
    now = 12_000;
    await engine.resumeDueTimers(now);
    const run = await store.getRun('run-4');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('done');
    expect(order).toEqual(['before', 'after']);
  });

  it('suspends on waitForSignal and resumes with the delivered payload', async () => {
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) => {
      const decision = await ctx.waitForSignal<{ approved: boolean }>('approve:run-5');
      return decision.approved ? 'shipped' : 'held';
    });
    await engine.start('approval', {}, 'run-5');
    expect((await engine.waitForRun('run-5')).status).toBe('suspended');
    // A waiter is durably recorded against the token.
    expect((await store.listSignalWaiters('approve:')).map((w) => w.runId)).toContain('run-5');

    const result = await engine.signal('approve:run-5', { approved: true });
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('shipped');
    // Waiter consumed.
    expect(await store.listSignalWaiters('approve:')).toHaveLength(0);
  });

  it('survives a fresh engine instance reading the same store (cross-process restart)', async () => {
    const engineA = new WorkflowEngine({ store });
    engineA.register('wf', '1', async (ctx) => {
      await ctx.waitForSignal('go:run-6');
      return 'finished';
    });
    await engineA.start('wf', {}, 'run-6');
    expect((await engineA.waitForRun('run-6')).status).toBe('suspended');

    // A brand-new engine (simulating a process restart) sees the suspended run in the store and
    // resumes it on signal — durability across instances.
    const engineB = new WorkflowEngine({ store });
    engineB.register('wf', '1', async (ctx) => {
      await ctx.waitForSignal('go:run-6');
      return 'finished';
    });
    const result = await engineB.signal('go:run-6', null);
    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('finished');
  });
});

import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine.js';
import { SINGLETON_ADMITTED_TAG } from '../../../src/singleton-admission.js';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { makeStoreDb } from '../../../src/stores/lucid-helpers.js';

let db: Database;
let store: LucidStateStore;

beforeEach(async () => {
  db = await makeStoreDb();
  store = new LucidStateStore(db);
});

afterEach(async () => {
  await db.manager.closeAll();
});

const noDispatch = { dispatch: () => {} };

describe('singleton admission over LucidStateStore', () => {
  it('two replicas over one store admit one run at a time, in FIFO order', async () => {
    const replicas = [
      new WorkflowEngine({ store, runDispatcher: noDispatch, instanceId: 'a' }),
      new WorkflowEngine({ store, runDispatcher: noDispatch, instanceId: 'b' }),
    ] as const;
    let inBody = 0;
    let maxInBody = 0;
    const entered: string[] = [];
    for (const engine of replicas) {
      engine.register(
        'job',
        '1',
        async (ctx, input) => {
          await ctx.localStep('enter', async () => {
            inBody += 1;
            maxInBody = Math.max(maxInBody, inBody);
            entered.push(input as string);
          });
          await ctx.waitForSignal(`release:${input as string}`);
          await ctx.localStep('leave', async () => {
            inBody -= 1;
          });
        },
        { singleton: { key: () => 'k' } },
      );
    }
    const [a, b] = replicas;
    await a.start('job', 'older', 'older');
    await new Promise((r) => setTimeout(r, 5));
    await a.start('job', 'younger', 'younger');
    // B drives the younger run first while the older one is still pending, then A the older one.
    await b.runOne('younger');
    await a.runOne('older');
    expect(entered).toEqual(['older']);
    expect(maxInBody).toBe(1);
    expect((await store.getRun('younger'))?.status).toBe('suspended');
    expect((await store.getRun('older'))?.tags).toContain(SINGLETON_ADMITTED_TAG);

    // Releasing the holder settles it, frees the slot, and the waiter is admitted on its retry.
    await a.signal('release:older', null);
    await a.waitForRun('older');
    expect((await store.getRun('older'))?.tags).not.toContain(SINGLETON_ADMITTED_TAG);
    await b.runOne('younger');
    expect(entered).toEqual(['older', 'younger']);
    expect(maxInBody).toBe(1);
    await a.drain();
    await b.drain();
  });

  it('a denial never overwrites a run cancelled before the claim', async () => {
    await store.createRun({
      id: 'holder',
      workflow: 'job',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      tags: ['singleton:k', SINGLETON_ADMITTED_TAG],
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    await store.createRun({
      id: 'gone',
      workflow: 'job',
      workflowVersion: '1',
      status: 'cancelled',
      input: {},
      tags: ['singleton:k'],
      createdAt: new Date(2),
      updatedAt: new Date(2),
    });
    expect(await store.tryAdmitSingleton('gone', 'singleton:k', 'job', 1, 99_000)).toBe(false);
    const after = await store.getRun('gone');
    expect(after?.status).toBe('cancelled');
    expect(after?.wakeAt).toBeUndefined();
  });
});

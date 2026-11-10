import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A compensating cancel persists `cancelling` while the saga undoes, so the status shows the undo in
 * progress, a repeat cancel can't skip it, and crash recovery finishes it on any instance.
 */

async function until(predicate: () => boolean | Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

/** A saga parked on a signal whose one compensation waits for `release()` before it finishes. */
function sagaEngine(store: InMemoryStateStore, instanceId = 'a') {
  const engine = new WorkflowEngine({ store, instanceId });
  const undone: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  engine.register('saga', '1', async (ctx) => {
    await ctx.localStep('reserve', async () => 1, {
      compensate: async () => {
        await gate;
        undone.push('reserve');
      },
    });
    await ctx.waitForSignal('never');
  });
  return { engine, undone, release: () => release() };
}

describe('cancel({ compensate: true }) persists `cancelling`', () => {
  it('returns and stores `cancelling` while the undo runs, then settles `cancelled`', async () => {
    const store = new InMemoryStateStore();
    const { engine, undone, release } = sagaEngine(store);
    await engine.start('saga', {}, 's1');
    await engine.waitForRun('s1');

    const res = await engine.cancel('s1', { compensate: true });

    expect(res?.status).toBe('cancelling');
    expect((await store.getRun('s1'))?.status).toBe('cancelling');
    release();
    await until(async () => (await store.getRun('s1'))?.status === 'cancelled');
    expect(undone).toEqual(['reserve']);
  });

  it('a repeat cancel, with or without compensate, echoes `cancelling` and the undo still runs once', async () => {
    const store = new InMemoryStateStore();
    const { engine, undone, release } = sagaEngine(store);
    await engine.start('saga', {}, 's2');
    await engine.waitForRun('s2');

    await engine.cancel('s2', { compensate: true });
    expect((await engine.cancel('s2'))?.status).toBe('cancelling');
    expect((await engine.cancel('s2', { compensate: true }))?.status).toBe('cancelling');
    expect((await store.getRun('s2'))?.status).toBe('cancelling');

    release();
    await until(async () => (await store.getRun('s2'))?.status === 'cancelled');
    expect(undone).toEqual(['reserve']);
  });

  it('waitForRun does not settle on `cancelling`', async () => {
    const store = new InMemoryStateStore();
    const { engine, release } = sagaEngine(store);
    await engine.start('saga', {}, 's3');
    await engine.waitForRun('s3');

    await engine.cancel('s3', { compensate: true });
    const waiting = engine.waitForRun('s3', { timeoutMs: 5_000 });
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    release();
    expect((await waiting).status).toBe('cancelled');
  });

  it('a failed cancel-marker write fails the cancel and leaves the run as it was', async () => {
    const store = new InMemoryStateStore();
    const { engine } = sagaEngine(store);
    await engine.start('saga', {}, 's4');
    await engine.waitForRun('s4');

    const buffer = store.bufferSignal.bind(store);
    store.bufferSignal = async (token, payload) => {
      if (token.startsWith('cancel:')) throw new Error('store down');
      return buffer(token, payload);
    };

    await expect(engine.cancel('s4', { compensate: true })).rejects.toThrow('store down');
    expect((await store.getRun('s4'))?.status).toBe('suspended');
  });
});

describe('crash recovery re-drives a `cancelling` run', () => {
  it('another instance finishes the undo of a run whose cancelling pod died', async () => {
    const store = new InMemoryStateStore();
    const first = sagaEngine(store, 'a');
    await first.engine.start('saga', {}, 's5');
    await first.engine.waitForRun('s5');
    // The pod that took the cancel dies before its undo ran: the row reads `cancelling` and nothing
    // in memory survives. No marker either, so only the persisted status carries the intent.
    await store.updateRun('s5', { status: 'cancelling', updatedAt: new Date() });

    const second = sagaEngine(store, 'b');
    second.release();
    const recovered = await second.engine.recoverIncomplete();

    expect(recovered.map((r) => [r.runId, r.status])).toEqual([['s5', 'cancelling']]);
    await until(async () => (await store.getRun('s5'))?.status === 'cancelled');
    expect(second.undone).toEqual(['reserve']);
    expect(first.undone).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { LucidStateStore } from '../../../src/stores/lucid.js';
import { runStateStoreContract } from '../../../src/testing-kit/conformance.js';
import { dbBackends } from '../../support/backends.js';

describe.each(dbBackends({ mysql: true }))('on $name', ({ makeStoreDb }) => {
  /**
   * Run the shared cross-store contract against the real Lucid store on an in-memory SQLite, so the
   * production store's behaviour is pinned identical to the canonical in-memory reference — including
   * the search-attribute side-table pushdown, lease/lock atomicity, and deleteRun cascade.
   */
  runStateStoreContract('LucidStateStore', async () => {
    const db = await makeStoreDb();
    return {
      store: new LucidStateStore(db),
      cleanup: async () => {
        await db.manager.closeAll();
      },
    };
  });

  describe('LucidStateStore fan methods', () => {
    it('implements every optional method the ctx.all join barriers and folding use', async () => {
      const db = await makeStoreDb();
      try {
        const store = new LucidStateStore(db);
        expect(store.hasSignalWaiter).toBeTypeOf('function');
        expect(store.registerChildWaits).toBeTypeOf('function');
        expect(store.compactCheckpoints).toBeTypeOf('function');
        expect(store.listSignalWaitersByRunIds).toBeTypeOf('function');
        expect(store.countCheckpoints).toBeTypeOf('function');
        expect(store.saveCheckpointIfPending).toBeTypeOf('function');
        expect(store.getRuns).toBeTypeOf('function');
        expect(store.releaseRunLockUnlessWakeRequested).toBeTypeOf('function');
        expect(store.listBufferedSignals).toBeTypeOf('function');
        expect(store.deleteBufferedSignals).toBeTypeOf('function');
      } finally {
        await db.manager.closeAll();
      }
    });
  });
});

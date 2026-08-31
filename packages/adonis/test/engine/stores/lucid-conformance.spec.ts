import { LucidStateStore } from '../../../src/stores/lucid.js';
import { makeStoreDb } from '../../../src/stores/lucid-helpers.js';
import { runStateStoreContract } from '../../../src/testing-kit/conformance.js';

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

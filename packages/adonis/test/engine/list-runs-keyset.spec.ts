import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunListPosition, StateStore, WorkflowRun } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import {
  createDurableRunListIndexes,
  DURABLE_RUN_LIST_INDEXES,
  dropDurableRunListIndexes,
} from '../../src/stores/lucid-schema.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * 11 runs created at only three instants, so most of them tie on `created_at` and only the id keeps
 * the pages apart; every other one `failed`, the rest `completed`.
 */
async function seed(store: StateStore): Promise<void> {
  for (let n = 0; n < 11; n++) {
    const at = new Date(1_700_000_000_000 + Math.floor(n / 4) * 1000);
    await store.createRun({
      id: `run-${String((n * 7) % 11).padStart(2, '0')}`,
      workflow: n % 3 === 0 ? 'billing' : 'mail',
      workflowVersion: '1',
      status: n % 2 === 0 ? 'failed' : 'completed',
      input: {},
      createdAt: at,
      updatedAt: at,
    });
  }
}

/** Every page of `size` runs, following the last run of each page. */
async function walk(
  store: StateStore,
  query: Parameters<StateStore['listRuns']>[0],
  size: number,
): Promise<string[][]> {
  const pages: string[][] = [];
  let after: RunListPosition | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const rows = await store.listRuns({ ...query, size: size + 1, ...(after ? { after } : {}) });
    const page = rows.slice(0, size);
    pages.push(page.map((run) => run.id));
    if (rows.length <= size) return pages;
    const last = page.at(-1) as WorkflowRun;
    after = { createdAt: last.createdAt.getTime(), id: last.id };
  }
  throw new Error('no last page');
}

const opened: Database[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.manager.closeAll();
});

const stores: Array<[string, () => Promise<StateStore>]> = [
  ['in-memory', async () => new InMemoryStateStore()],
  ...dbBackends({ mysql: true }).map((backend): [string, () => Promise<StateStore>] => [
    `lucid (${backend.name})`,
    async () => {
      const db = await backend.makeStoreDb();
      opened.push(db);
      return new LucidStateStore(db);
    },
  ]),
];

describe.each(stores)('listRuns keyset paging (%s)', (_label, makeStore) => {
  it('walks every run once, newest first, across ties on createdAt', async () => {
    const store = await makeStore();
    await seed(store);
    const pages = await walk(store, {}, 3);
    expect(pages.map((page) => page.length)).toEqual([3, 3, 3, 2]);
    const ids = pages.flat();
    expect(new Set(ids).size).toBe(11);
    // The same order as one unpaged read: newest instant first, id descending inside it.
    expect(ids).toEqual((await store.listRuns({})).map((run) => run.id));
  });

  it('keeps the filters on every page', async () => {
    const store = await makeStore();
    await seed(store);
    const failed = (await walk(store, { status: 'failed' }, 2)).flat();
    expect(failed).toEqual((await store.listRuns({ status: 'failed' })).map((run) => run.id));
    expect(failed).toHaveLength(6);
    const billing = (await walk(store, { workflow: 'billing', status: 'failed' }, 1)).flat();
    expect(billing).toEqual(
      (await store.listRuns({ workflow: 'billing', status: 'failed' })).map((run) => run.id),
    );
  });

  it('still pages by page/size, in the same order', async () => {
    const store = await makeStore();
    await seed(store);
    const all = (await store.listRuns({})).map((run) => run.id);
    const second = await store.listRuns({ page: 2, size: 4 });
    expect(second.map((run) => run.id)).toEqual(all.slice(4, 8));
  });
});

describe.each(dbBackends({ mysql: true }))('the opt-in run list index ($name)', (backend) => {
  it('creates once, re-runs as a no-op, and drops', async () => {
    const db = await backend.makeStoreDb();
    opened.push(db);
    await createDurableRunListIndexes(db);
    await createDurableRunListIndexes(db);
    await dropDurableRunListIndexes(db);
    await dropDurableRunListIndexes(db);
    await createDurableRunListIndexes(db);
    // And the store still lists through it.
    const store = new LucidStateStore(db);
    await seed(store);
    expect((await walk(store, { status: 'failed' }, 4)).flat()).toHaveLength(6);
    expect(DURABLE_RUN_LIST_INDEXES.length).toBeGreaterThan(0);
  });
});

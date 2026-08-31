import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepCheckpoint, WorkflowRun } from '../../../src/interfaces.js';
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

const at = new Date('2026-06-11T00:00:00.000Z');
const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'running',
  input: { orderId: 'o1' },
  createdAt: at,
  updatedAt: at,
  ...over,
});
const checkpoint = (over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
  runId: 'r1',
  seq: 0,
  name: 'reserve',
  kind: 'local',
  stepId: 'r1:0',
  status: 'completed',
  output: { ok: true },
  attempts: 1,
  enqueuedAt: at,
  startedAt: at,
  finishedAt: at,
  ...over,
});

describe('LucidStateStore — runs & checkpoints', () => {
  it('persists a run with JSON input and reads it back', async () => {
    await store.createRun(run());
    const loaded = await store.getRun('r1');
    expect(loaded?.workflow).toBe('checkout');
    expect(loaded?.input).toEqual({ orderId: 'o1' });
    expect(loaded?.status).toBe('running');
    expect(loaded?.createdAt.getTime()).toBe(at.getTime());
  });

  it('returns null for a missing run', async () => {
    expect(await store.getRun('nope')).toBeNull();
  });

  it('idempotent-ish create then update round-trips the patch (clearing columns)', async () => {
    await store.createRun(run({ error: { message: 'boom' }, lockedBy: 'a', lockedUntil: 5 }));
    await store.updateRun('r1', {
      status: 'completed',
      output: { total: 42 },
      error: undefined,
      lockedBy: undefined,
      lockedUntil: undefined,
    });
    const loaded = await store.getRun('r1');
    expect(loaded?.status).toBe('completed');
    expect(loaded?.output).toEqual({ total: 42 });
    expect(loaded?.error).toBeUndefined();
    expect(loaded?.lockedBy).toBeUndefined();
    expect(loaded?.lockedUntil).toBeUndefined();
  });

  it('persists a run-level priority and reads it back; absent stays unprioritised', async () => {
    await store.createRun(run({ id: 'p', priority: 7 }));
    expect((await store.getRun('p'))?.priority).toBe(7);
    // A run started without a priority reads back as absent (FIFO path untouched).
    await store.createRun(run({ id: 'q' }));
    expect((await store.getRun('q'))?.priority).toBeUndefined();
    // A patch can update the priority in place.
    await store.updateRun('p', { priority: 2 });
    expect((await store.getRun('p'))?.priority).toBe(2);
  });

  it('upserts checkpoints and reads them by (runId, seq)', async () => {
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint());
    await store.saveCheckpoint(
      checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
    );
    expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true });
    expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
    expect(await store.listCheckpoints('r1')).toHaveLength(2);
  });

  it('overwrites a checkpoint at the same seq (idempotent save)', async () => {
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint({ status: 'running', output: undefined }));
    await store.saveCheckpoint(checkpoint({ status: 'completed', output: { ok: true } }));
    const cp = await store.getCheckpoint('r1', 0);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ ok: true });
    expect(await store.listCheckpoints('r1')).toHaveLength(1);
  });

  it('listCheckpoints orders by seq; targeted reads filter by name / prefix', async () => {
    await store.createRun(run());
    await store.saveCheckpoint(checkpoint({ seq: 0, name: 'event:progress', output: 10 }));
    await store.saveCheckpoint(checkpoint({ seq: 1, name: 'signal:child:a', output: 1 }));
    await store.saveCheckpoint(checkpoint({ seq: 2, name: 'event:progress', output: 20 }));
    expect((await store.listCheckpoints('r1')).map((c) => c.seq)).toEqual([0, 1, 2]);
    // highest-seq match wins for getLatestCheckpointByName
    expect((await store.getLatestCheckpointByName('r1', 'event:progress'))?.output).toBe(20);
    expect(await store.getLatestCheckpointByName('r1', 'absent')).toBeUndefined();
    const prefixed = await store.listCheckpointsByNamePrefix('r1', ['signal:child:', 'spawn:']);
    expect(prefixed.map((c) => c.seq)).toEqual([1]);
    expect(await store.listCheckpointsByNamePrefix('r1', [])).toEqual([]);
  });
});

describe('LucidStateStore — recovery / dispatch queries', () => {
  it('lists incomplete runs and due timers', async () => {
    await store.createRun(run({ id: 'running1', status: 'running' }));
    await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
    await store.createRun(run({ id: 'done1', status: 'completed' }));
    expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
    expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
    expect(await store.listDueTimers(1_000)).toHaveLength(0);
  });

  it('lists pending runs oldest-first (FIFO), capped at the limit', async () => {
    await store.createRun(run({ id: 'p2', status: 'pending', createdAt: new Date(2000) }));
    await store.createRun(run({ id: 'p1', status: 'pending', createdAt: new Date(1000) }));
    await store.createRun(run({ id: 'p3', status: 'pending', createdAt: new Date(3000) }));
    await store.createRun(run({ id: 'running1', status: 'running' }));
    expect((await store.listPendingRuns(10)).map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    expect((await store.listPendingRuns(2)).map((r) => r.id)).toEqual(['p1', 'p2']);
  });
});

describe('LucidStateStore — recovery lease (atomic)', () => {
  it('tryLockRun is atomic and respects lease expiry', async () => {
    await store.createRun(run({ id: 'r1' }));
    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
    // B cannot take while A's lease is live.
    expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
    // Once A's lease expired (nowMs 2_500 > 2_000), B can take over.
    expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true);
    await store.releaseRunLock('r1');
    expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
  });

  it('renewRunLock only succeeds for the current owner', async () => {
    await store.createRun(run({ id: 'r1' }));
    expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
    // A heartbeats and keeps the lease.
    expect(await store.renewRunLock('r1', 'A', 5_000)).toBe(true);
    // A non-owner can never renew.
    expect(await store.renewRunLock('r1', 'B', 9_000)).toBe(false);
    // The renewed lease is still live at now=4_000, so B can't steal it.
    expect(await store.tryLockRun('r1', 'B', 9_000, 4_000)).toBe(false);
    // After the renewed lease expires, B reclaims it; A can no longer renew.
    expect(await store.tryLockRun('r1', 'B', 9_000, 6_000)).toBe(true);
    expect(await store.renewRunLock('r1', 'A', 12_000)).toBe(false);
  });

  it('tryLockRun on a missing run does not throw and reports false', async () => {
    expect(await store.tryLockRun('ghost', 'A', 1_000, 0)).toBe(false);
  });
});

describe('LucidStateStore — signals', () => {
  it('stores and atomically takes a signal waiter', async () => {
    await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
    expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
    expect(await store.takeSignalWaiter('approve-1')).toBeNull();
  });

  it('upserts a waiter at the same token', async () => {
    await store.putSignalWaiter({ token: 't', runId: 'r1', seq: 1 });
    await store.putSignalWaiter({ token: 't', runId: 'r2', seq: 5 });
    const taken = await store.takeSignalWaiter('t');
    expect(taken).toEqual({ token: 't', runId: 'r2', seq: 5 });
  });

  it('lists waiters by token prefix (event fan-out)', async () => {
    await store.putSignalWaiter({ token: 'evt:order.paid:1', runId: 'r1', seq: 1 });
    await store.putSignalWaiter({ token: 'evt:order.paid:2', runId: 'r2', seq: 1 });
    await store.putSignalWaiter({ token: 'evt:other:1', runId: 'r3', seq: 1 });
    const matched = await store.listSignalWaiters('evt:order.paid:');
    expect(matched.map((w) => w.runId).sort()).toEqual(['r1', 'r2']);
  });

  it('buffers signals FIFO per token', async () => {
    await store.bufferSignal('t', { n: 1 });
    await store.bufferSignal('t', { n: 2 });
    expect(await store.takeBufferedSignal('t')).toEqual({ payload: { n: 1 } });
    expect(await store.takeBufferedSignal('t')).toEqual({ payload: { n: 2 } });
    expect(await store.takeBufferedSignal('t')).toBeNull();
  });

  it('preserves an undefined buffered payload', async () => {
    await store.bufferSignal('t', undefined);
    expect(await store.takeBufferedSignal('t')).toEqual({ payload: undefined });
  });
});

describe('LucidStateStore — search attributes & queries', () => {
  it('round-trips searchAttributes and answers equality + range queries', async () => {
    await store.createRun(run({ id: 'a', searchAttributes: { amount: 30, tier: 'free' } }));
    await store.createRun(run({ id: 'b', searchAttributes: { amount: 200, tier: 'pro' } }));
    await store.createRun(run({ id: 'c', searchAttributes: { amount: 500, tier: 'pro' } }));

    expect((await store.getRun('b'))?.searchAttributes).toEqual({ amount: 200, tier: 'pro' });
    const big = await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 200 }] });
    expect(big.map((r) => r.id).sort()).toEqual(['b', 'c']);
    const proSmall = await store.listRuns({
      attributes: [
        { key: 'tier', op: 'eq', value: 'pro' },
        { key: 'amount', op: 'lt', value: 300 },
      ],
    });
    expect(proSmall.map((r) => r.id)).toEqual(['b']);
    // `ne` excludes the matching value AND absent keys (missing-key-never-matches contract).
    const notFree = await store.listRuns({
      attributes: [{ key: 'tier', op: 'ne', value: 'free' }],
    });
    expect(notFree.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });

  it('upserts the side-table on create and re-indexes on update', async () => {
    await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 10 } }));
    await store.updateRun('a', { searchAttributes: { tier: 'pro' } });
    expect(
      (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).map(
        (r) => r.id,
      ),
    ).toEqual(['a']);
    // Old rows gone after reindex.
    expect(
      await store.listRuns({ attributes: [{ key: 'amount', op: 'eq', value: 10 }] }),
    ).toHaveLength(0);
    expect(
      await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] }),
    ).toHaveLength(0);
  });

  it('filters by workflow / status / statuses / tag and paginates newest-first', async () => {
    await store.createRun(
      run({
        id: 'a',
        workflow: 'checkout',
        status: 'completed',
        tags: ['etl'],
        createdAt: new Date(1),
      }),
    );
    await store.createRun(
      run({
        id: 'b',
        workflow: 'checkout',
        status: 'running',
        tags: ['etl-foo'],
        createdAt: new Date(2),
      }),
    );
    await store.createRun(
      run({ id: 'c', workflow: 'refund', status: 'suspended', createdAt: new Date(3) }),
    );

    expect((await store.listRuns({ workflow: 'checkout' })).map((r) => r.id)).toEqual(['b', 'a']);
    expect((await store.listRuns({ status: 'running' })).map((r) => r.id)).toEqual(['b']);
    expect(
      (await store.listRuns({ statuses: ['running', 'suspended'] })).map((r) => r.id).sort(),
    ).toEqual(['b', 'c']);
    expect(await store.listRuns({ statuses: [] })).toHaveLength(0);
    // `etl` must not match `etl-foo` (quoted-token match).
    expect((await store.listRuns({ tag: 'etl' })).map((r) => r.id)).toEqual(['a']);
    expect((await store.listRuns({ limit: 1 })).map((r) => r.id)).toEqual(['c']);
    expect((await store.listRuns({ limit: 1, offset: 1 })).map((r) => r.id)).toEqual(['b']);
  });
});

describe('LucidStateStore — transaction', () => {
  it('commits a business write + checkpoint atomically', async () => {
    await store.createRun(run());
    const result = await store.transaction(async (tx) => {
      await store.saveCheckpoint; // ensure store still usable
      await tx.saveCheckpoint(checkpoint({ seq: 0, name: 'charge', output: { id: 'x' } }));
      return 'ok';
    });
    expect(result).toBe('ok');
    expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ id: 'x' });
  });

  it('rolls back the checkpoint when the work throws', async () => {
    await store.createRun(run());
    await expect(
      store.transaction(async (tx) => {
        await tx.saveCheckpoint(checkpoint({ seq: 0 }));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.getCheckpoint('r1', 0)).toBeNull();
  });
});

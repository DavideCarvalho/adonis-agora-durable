import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { StepCheckpoint, WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const run = (over: Partial<WorkflowRun> & { id: string }): WorkflowRun => ({
  workflow: 'wf',
  workflowVersion: '1',
  status: 'completed',
  input: {},
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
  ...over,
});

describe('retention sweep', () => {
  it('evicts terminal runs past their configured age (by last activity), keeping the rest', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      retention: { completed: 1_000, failed: 5_000 },
      clock: () => 10_000,
    });
    await store.createRun(run({ id: 'old-completed', updatedAt: new Date(2_000) }));
    await store.createRun(run({ id: 'fresh-completed', updatedAt: new Date(9_500) }));
    await store.createRun(run({ id: 'old-failed', status: 'failed', updatedAt: new Date(2_000) }));
    await store.createRun(
      run({ id: 'young-failed', status: 'failed', updatedAt: new Date(6_000) }),
    );
    // No policy for cancelled — kept regardless of age.
    await store.createRun(
      run({ id: 'old-cancelled', status: 'cancelled', updatedAt: new Date(1_000) }),
    );
    // Non-terminal statuses are never candidates.
    await store.createRun(run({ id: 'live', status: 'suspended', updatedAt: new Date(1_000) }));

    const evicted = await engine.sweepRetention();
    expect(evicted).toBe(2);
    expect(await store.getRun('old-completed')).toBeNull();
    expect(await store.getRun('old-failed')).toBeNull();
    expect((await store.getRun('fresh-completed'))?.id).toBe('fresh-completed');
    expect((await store.getRun('young-failed'))?.id).toBe('young-failed');
    expect((await store.getRun('old-cancelled'))?.id).toBe('old-cancelled');
    expect((await store.getRun('live'))?.id).toBe('live');
  });

  it('is self-throttled: a second sweep inside the minute is a no-op', async () => {
    const store = new InMemoryStateStore();
    let nowMs = 100_000;
    const engine = new WorkflowEngine({
      store,
      retention: { completed: 1_000 },
      clock: () => nowMs,
    });
    await store.createRun(run({ id: 'a', updatedAt: new Date(1_000) }));
    expect(await engine.sweepRetention()).toBe(1);
    await store.createRun(run({ id: 'b', updatedAt: new Date(1_000) }));
    expect(await engine.sweepRetention()).toBe(0); // throttled
    nowMs += 61_000;
    expect(await engine.sweepRetention()).toBe(1); // next minute picks it up
  });

  it('onEvict archives before deletion, and a throwing hook SKIPS the delete', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      retention: { completed: 1_000 },
      clock: () => 10_000,
    });
    await store.createRun(run({ id: 'keep', updatedAt: new Date(1_000) }));
    await store.createRun(run({ id: 'archive', updatedAt: new Date(1_000) }));
    await store.saveCheckpoint({
      runId: 'archive',
      seq: 0,
      name: 'step',
      kind: 'local',
      stepId: 'archive:0',
      status: 'completed',
      attempts: 1,
      enqueuedAt: new Date(1_000),
      startedAt: new Date(1_000),
      finishedAt: new Date(1_000),
    });
    const archived: Array<{ run: WorkflowRun; checkpoints: StepCheckpoint[] }> = [];
    engine.onEvict(async (r, cps) => {
      if (r.id === 'keep') throw new Error('archive backend down');
      archived.push({ run: r, checkpoints: cps });
    });

    const evicted = await engine.sweepRetention();
    expect(evicted).toBe(1);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.run.id).toBe('archive');
    expect(archived[0]?.checkpoints).toHaveLength(1);
    // The hook failure kept the run — archival problems must never lose data.
    expect((await store.getRun('keep'))?.id).toBe('keep');
  });

  it('no policy → no-op', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => 10_000 });
    await store.createRun(run({ id: 'a', updatedAt: new Date(1_000) }));
    expect(await engine.sweepRetention()).toBe(0);
    expect((await store.getRun('a'))?.id).toBe('a');
  });
});

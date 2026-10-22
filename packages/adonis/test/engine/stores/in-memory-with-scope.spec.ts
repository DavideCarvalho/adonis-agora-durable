import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../../src/interfaces.js';
import { InMemoryStateStore } from '../../../src/testing/in-memory-state-store.js';

const run = (id: string, namespace: string): WorkflowRun => ({
  id,
  workflow: 'wf',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  namespace,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('InMemoryStateStore.withScope — a view over the SAME state', () => {
  it('writes through the view are visible on the base and vice versa', async () => {
    const base = new InMemoryStateStore();
    const view = base.withScope({ namespace: 'acme' });

    await view.createRun(run('a1', 'acme'));
    expect((await base.getRun('a1'))?.namespace).toBe('acme');

    await base.createRun(run('a2', 'acme'));
    await base.createRun(run('b1', 'blue'));
    expect((await view.listPendingRuns(10)).map((r) => r.id).sort()).toEqual(['a1', 'a2']);

    await view.bufferSignal('t', 1);
    expect(await base.takeBufferedSignal('t')).toEqual({ payload: 1 });
  });

  it('the read counters are shared, not shadowed per view', async () => {
    const base = new InMemoryStateStore();
    const view = base.withScope({ namespace: 'acme' });
    await base.createRun(run('a1', 'acme'));
    await base.saveCheckpoint({
      runId: 'a1',
      seq: 0,
      name: 's',
      kind: 'local',
      status: 'completed',
      attempts: 1,
      startedAt: new Date(),
    } as never);

    await view.listCheckpoints('a1');
    expect(base.lastCheckpointRowsRead).toBe(1);
    expect(base.checkpointRowsRead).toBe(1);
    await base.listCheckpoints('a1');
    expect(view.checkpointRowsRead).toBe(2);
  });

  it('a view of a view keeps the new scope and the shared state', async () => {
    const base = new InMemoryStateStore();
    const blue = base.withScope({ namespace: 'acme' }).withScope({ namespace: 'blue' });
    await base.createRun(run('b1', 'blue'));
    await base.createRun(run('a1', 'acme'));
    expect((await blue.listPendingRuns(10)).map((r) => r.id)).toEqual(['b1']);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 29, 12);

// A run left behind by a deploy that renamed its workflow: nothing registers `index-writing` anymore.
const orphan = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'sched:index-writing:1',
  workflow: 'index-writing',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  createdAt: new Date(NOW - 48 * HOUR),
  updatedAt: new Date(NOW - 48 * HOUR),
  ...over,
});

const engineWith = (store: InMemoryStateStore, unregisteredWorkflowGraceMs?: number) => {
  const engine = new WorkflowEngine({ store, clock: () => NOW, unregisteredWorkflowGraceMs });
  engine.register('IndexWriting', '1', async () => 'ok');
  return engine;
};

describe('a run whose workflow is registered nowhere', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is dead-lettered once it has been due past the grace (default 24h)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new InMemoryStateStore();
    const engine = engineWith(store);
    const dead: string[] = [];
    engine.onDead((run) => dead.push(run.id));
    await store.createRun(orphan());

    await engine.runPending(NOW);

    const run = await store.getRun('sched:index-writing:1');
    expect(run?.status).toBe('dead');
    expect(run?.error?.code).toBe('workflow_not_registered');
    expect(dead).toEqual(['sched:index-writing:1']);
    // Terminal: the next tick no longer picks it up.
    expect(await store.listPendingRuns(10)).toEqual([]);
  });

  it('is left for the pod that has the version while within the grace (rolling deploy)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStateStore();
    const engine = engineWith(store);
    await store.createRun(orphan({ updatedAt: new Date(NOW - 5 * 60 * 1000) }));

    await engine.runPending(NOW);

    expect((await store.getRun('sched:index-writing:1'))?.status).toBe('pending');
  });

  it('counts from the wake, not from when a long sleep began', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStateStore();
    const engine = engineWith(store);
    // Suspended 7 days ago on a sleep that came due a minute ago.
    await store.createRun(
      orphan({
        status: 'suspended',
        updatedAt: new Date(NOW - 7 * 24 * HOUR),
        wakeAt: NOW - 60 * 1000,
      }),
    );

    await engine.resumeDueTimers(NOW);

    expect((await store.getRun('sched:index-writing:1'))?.status).toBe('suspended');
  });

  it('honours a custom grace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new InMemoryStateStore();
    const engine = engineWith(store, HOUR);
    await store.createRun(orphan({ updatedAt: new Date(NOW - 2 * HOUR) }));

    await engine.runPending(NOW);

    expect((await store.getRun('sched:index-writing:1'))?.status).toBe('dead');
  });

  it('is skipped forever with a grace of 0', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new InMemoryStateStore();
    const engine = engineWith(store, 0);
    await store.createRun(orphan({ updatedAt: new Date(NOW - 365 * 24 * HOUR) }));

    await engine.runPending(NOW);

    expect((await store.getRun('sched:index-writing:1'))?.status).toBe('pending');
  });
});

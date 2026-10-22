import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const pending = (id: string, createdMs: number): WorkflowRun => ({
  id,
  workflow: 'job',
  workflowVersion: '1',
  status: 'pending',
  input: {},
  createdAt: new Date(createdMs),
  updatedAt: new Date(createdMs),
});

let errors: unknown[][];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('resumeLeased: one bad run never aborts the recovery batch', () => {
  it('skips (and reports) a run that throws, and drives the rest of the batch', async () => {
    const store = new InMemoryStateStore();
    // More runs than the sweep's 8 parallel workers, the bad one first, so on the old code the
    // worker that hit it stopped and the sweep itself rejected into the poller.
    await store.createRun(pending('bad-run', 1));
    for (let i = 0; i < 12; i++) await store.createRun(pending(`ok-${i}`, 10 + i));
    const getRun = store.getRun.bind(store);
    vi.spyOn(store, 'getRun').mockImplementation(async (id) => {
      if (id === 'bad-run') throw new Error('row is corrupt');
      return getRun(id);
    });
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('job', '1', async () => 'done');

    const results = await engine.runPending();

    expect(results).toHaveLength(12);
    for (let i = 0; i < 12; i++) expect((await getRun(`ok-${i}`))?.status).toBe('completed');
    const reported = errors.flat().map(String).join(' ');
    expect(reported).toContain('bad-run');
    expect(reported).toContain('job@1');
  });

  it('gives the lease back instead of starting a run when drain begins during the lock', async () => {
    const inner = new InMemoryStateStore();
    let engine!: WorkflowEngine;
    const tryLock = inner.tryLockRun.bind(inner);
    vi.spyOn(inner, 'tryLockRun').mockImplementation(async (...args) => {
      const got = await tryLock(...args);
      engine.beginDrain(); // the stop lands while the lock is being taken
      return got;
    });
    engine = new WorkflowEngine({ store: inner, runDispatcher: { dispatch: () => {} } });
    let bodyRuns = 0;
    engine.register('job', '1', async () => {
      bodyRuns += 1;
    });
    await inner.createRun(pending('r1', 1));

    expect(await engine.runPending()).toEqual([]);
    expect(bodyRuns).toBe(0);
    // The lease was handed back: another instance can take the run at once.
    vi.mocked(inner.tryLockRun).mockRestore();
    expect(await inner.tryLockRun('r1', 'other', Date.now() + 60_000, Date.now())).toBe(true);
  });
});

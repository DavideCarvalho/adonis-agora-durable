import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RunStatus } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * `waitForRun` across instances. Lifecycle events only reach the instance that executes the run (or
 * travel over an optional, best-effort control plane), so a wait on another pod must also re-read the
 * run, or it hangs until its timeout although the run is long done.
 */

function pod(store: InMemoryStateStore, name: string, deps: { waitForRunPollMs?: number } = {}) {
  const engine = new WorkflowEngine({
    store,
    transport: new InMemoryTransport(),
    instanceId: name,
    ...deps,
  });
  engine.register('wf', '1', async () => 'done');
  return engine;
}

async function seed(store: InMemoryStateStore, id: string, status: RunStatus): Promise<void> {
  const now = new Date();
  await store.createRun({
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status,
    input: {},
    createdAt: now,
    updatedAt: now,
  });
}

describe('waitForRun on a run that settles on another instance', () => {
  it('terminal mode resolves once the other pod completes the run, without a control plane', async () => {
    const store = new InMemoryStateStore();
    const executor = pod(store, 'a');
    const waiter = pod(store, 'b');

    const waiting = waiter.waitForRun('r1', { terminal: true, timeoutMs: 3000 });
    await executor.start('wf', {}, 'r1');

    const result = await waiting;
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');
  });

  it('settled mode sees a status written by another pod', async () => {
    const store = new InMemoryStateStore();
    const waiter = pod(store, 'b');
    await seed(store, 'r2', 'running');

    const waiting = waiter.waitForRun('r2', { timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 50));
    await store.updateRun('r2', { status: 'suspended', wakeAt: Date.now() + 60_000 });

    expect((await waiting).status).toBe('suspended');
  });

  it('the read interval is configurable per engine and per call; 0 turns it off', async () => {
    const store = new InMemoryStateStore();
    const noPoll = pod(store, 'b', { waitForRunPollMs: 0 });
    await seed(store, 'r3', 'running');

    const off = noPoll.waitForRun('r3', { terminal: true, timeoutMs: 400 });
    const perCall = noPoll.waitForRun('r3', { terminal: true, timeoutMs: 3000, pollMs: 20 });
    await new Promise((r) => setTimeout(r, 50));
    await store.updateRun('r3', { status: 'completed', output: 'x' });

    expect((await perCall).status).toBe('completed');
    await expect(off).rejects.toThrow(/timed out/);
  });
});

describe('waitForRun on a blocked run', () => {
  it('does not settle on blocked; resolves once the run moves on', async () => {
    const store = new InMemoryStateStore();
    const waiter = pod(store, 'b', { waitForRunPollMs: 20 });
    await seed(store, 'r4', 'blocked');

    await expect(waiter.waitForRun('r4', { timeoutMs: 200 })).rejects.toThrow(/timed out/);

    const waiting = waiter.waitForRun('r4', { timeoutMs: 3000 });
    await store.updateRun('r4', { status: 'completed', output: 'ok' });
    expect((await waiting).status).toBe('completed');
  });
});

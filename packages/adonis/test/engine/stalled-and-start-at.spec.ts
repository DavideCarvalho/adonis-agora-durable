import { describe, expect, it } from 'vitest';
import { type StalledRunInfo, WorkflowEngine } from '../../src/engine.js';
import type { WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

const run = (over: Partial<WorkflowRun> & { id: string }): WorkflowRun => ({
  workflow: 'wf',
  workflowVersion: '1',
  status: 'suspended',
  input: {},
  createdAt: new Date(1_000),
  updatedAt: new Date(1_000),
  ...over,
});

describe('StartOptions.startAt — delayed start', () => {
  it('parks the run on its wake timer and the timer poller starts it when due', async () => {
    const store = new InMemoryStateStore();
    let nowMs = 1_000;
    const engine = new WorkflowEngine({ store, clock: () => nowMs });
    engine.register('wf', '1', async () => 'done');

    const result = await engine.start('wf', {}, 'later', { startAt: 5_000 });
    expect(result.status).toBe('suspended');
    await flush();
    expect((await store.getRun('later'))?.status).toBe('suspended');
    expect((await store.getRun('later'))?.wakeAt).toBe(5_000);

    // Not due yet — the timer poll leaves it alone.
    await engine.resumeDueTimers(4_000);
    await flush();
    expect((await store.getRun('later'))?.status).toBe('suspended');

    nowMs = 5_001;
    await engine.resumeDueTimers(nowMs);
    await flush();
    const done = await store.getRun('later');
    expect(done?.status).toBe('completed');
    expect(done?.output).toBe('done');
  });

  it('a past startAt starts immediately (plain pending dispatch)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'done');
    await engine.start('wf', {}, 'now', { startAt: Date.now() - 1_000 });
    await flush();
    expect((await store.getRun('now'))?.status).toBe('completed');
  });
});

describe('onStalled — stranded-run detection', () => {
  it('pages once per episode for a wake-forever suspension and a silent pending remote step', async () => {
    const store = new InMemoryStateStore();
    let nowMs = 10_000_000;
    const engine = new WorkflowEngine({ store, clock: () => nowMs, stalledAfterMs: 60_000 });
    const paged: StalledRunInfo[] = [];
    engine.onStalled((info) => paged.push(info));

    // (a) wake-forever: suspended, no wakeAt, untouched for ages.
    await store.createRun(run({ id: 'forever', updatedAt: new Date(nowMs - 120_000) }));
    // (b) silent pending remote step.
    await store.createRun(
      run({ id: 'lost-dispatch', updatedAt: new Date(nowMs - 120_000), wakeAt: nowMs + 300_000 }),
    );
    await store.saveCheckpoint({
      runId: 'lost-dispatch',
      seq: 0,
      name: 'ext.step',
      kind: 'remote',
      stepId: 'lost-dispatch:0',
      status: 'pending',
      attempts: 1,
      enqueuedAt: new Date(nowMs - 120_000),
      startedAt: new Date(nowMs - 120_000),
      finishedAt: new Date(nowMs - 120_000),
    });
    // Healthy long sleep: wakeAt in the future, no pending step — NOT stalled.
    await store.createRun(
      run({ id: 'sleeping', updatedAt: new Date(nowMs - 120_000), wakeAt: nowMs + 500_000 }),
    );
    // Beating long step: pending but with a fresh heartbeat — NOT stalled.
    await store.createRun(
      run({ id: 'beating', updatedAt: new Date(nowMs - 120_000), wakeAt: nowMs + 500_000 }),
    );
    await store.saveCheckpoint({
      runId: 'beating',
      seq: 0,
      name: 'ext.long',
      kind: 'remote',
      stepId: 'beating:0',
      status: 'pending',
      attempts: 1,
      enqueuedAt: new Date(nowMs - 120_000),
      startedAt: new Date(nowMs - 120_000),
      finishedAt: new Date(nowMs - 120_000),
      lastHeartbeatAt: new Date(nowMs - 5_000),
    });

    const notified = await engine.sweepStalled();
    expect(notified.map((n) => n.run.id).sort()).toEqual(['forever', 'lost-dispatch']);
    expect(paged.find((p) => p.run.id === 'forever')?.wakeForever).toBe(true);
    expect(paged.find((p) => p.run.id === 'lost-dispatch')?.stalePending?.name).toBe('ext.step');

    // Same episodes, next sweep — no duplicate pages. ('beating' DOES page now: its heartbeat has
    // been silent for the whole minute since — the disambiguator flipped from alive to silent.)
    nowMs += 61_000;
    expect((await engine.sweepStalled()).map((n) => n.run.id)).toEqual(['beating']);

    // The run progressed (updatedAt moved) and stranded again — a NEW episode pages again.
    await store.updateRun('forever', { updatedAt: new Date(nowMs - 120_000) });
    nowMs += 61_000;
    expect((await engine.sweepStalled()).map((n) => n.run.id)).toEqual(['forever']);
  });

  it('is a no-op without listeners', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => 10_000_000, stalledAfterMs: 60_000 });
    await store.createRun(run({ id: 'forever', updatedAt: new Date(1_000) }));
    expect(await engine.sweepStalled()).toEqual([]);
  });
});

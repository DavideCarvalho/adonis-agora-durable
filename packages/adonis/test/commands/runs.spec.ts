import { describe, expect, it } from 'vitest';
import {
  attachLiveness,
  DEFAULT_STALE_MS,
  filterStale,
  listRuns,
  parseDurationMs,
  renderRunsTable,
  retryRun,
  staleHint,
} from '../../src/commands/runs.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';

function makeEngine() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
  engine.register('checkout', '1', async (ctx) => {
    await ctx.localStep('reserve', async () => 1);
    return 'ok';
  });
  return { store, engine };
}

/** A transport that captures dispatches but never delivers a result — models a worker that crashed
 *  (or a dropped job), the exact scenario `--stale`/liveness is built to surface. Mirrors the
 *  `LostTransport` used by `test/engine/redispatch-pending.spec.ts`. */
class LostTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  result?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.result = handler;
  }
  onHeartbeat(): void {}
}

/**
 * A run suspended on a remote step whose result never arrives — the exact "lost dispatch" shape
 * liveness is built to surface. NOTE: the checkpoint's `enqueuedAt` is stamped with the real wall
 * clock (`new Date()`) by `dispatchRemoteTask`, not the engine's injectable `clock` (that only drives
 * scheduler decisions like timer wake-ups) — so tests compute `now` relative to the checkpoint's
 * actual `enqueuedAt` rather than assuming a fixed epoch.
 */
async function makeStrandedRun() {
  const transport = new LostTransport();
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, transports: [{ id: 't', transport }] });
  engine.register('wf', '1', async (ctx) => {
    const r = await ctx.step<{ pong: boolean }>('ext.ping', {});
    return r.pong;
  });
  await startRun(engine, 'wf', {}, 'stuck1');
  const [checkpoint] = await store.listCheckpoints('stuck1');
  if (!checkpoint) throw new Error('expected a pending remote checkpoint');
  return { engine, store, transport, enqueuedAt: checkpoint.enqueuedAt.getTime() };
}

describe('listRuns / renderRunsTable', () => {
  it('lists completed runs and renders a table', async () => {
    const { store, engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    const runs = await listRuns(store, {});
    expect(runs.map((r) => r.id)).toContain('run1');

    const table = renderRunsTable(await attachLiveness(store, runs));
    expect(table).toContain('WORKFLOW');
    expect(table).toContain('RECOVERY');
    expect(table).toContain('PENDING');
    expect(table).toContain('checkout');
    expect(table).toContain('completed');
  });

  it('filters by status', async () => {
    const { store, engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    expect(await listRuns(store, { status: 'completed' })).toHaveLength(1);
    expect(await listRuns(store, { status: 'failed' })).toHaveLength(0);
  });

  it('says when there are no runs', () => {
    expect(renderRunsTable([])).toMatch(/no runs/i);
  });
});

describe('retryRun', () => {
  it('re-enqueues an existing run to pending', async () => {
    const { store, engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    const result = await retryRun(engine, 'run1');
    expect(result).not.toBeNull();
    expect(result?.runId).toBe('run1');
    // requeue returns the enqueued state immediately; the in-process dispatcher then picks it up, so
    // the run leaves the terminal `completed` state and re-executes.
    expect(result?.status).toBe('pending');
    await engine.waitForRun('run1');
    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
  });

  it('returns null for an unknown run', async () => {
    const { engine } = makeEngine();
    expect(await retryRun(engine, 'nope')).toBeNull();
  });
});

describe('listRuns via the engine read API', () => {
  it('lists runs through engine.listRuns (same surface the command uses)', async () => {
    const { engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');
    const runs = await listRuns(engine, { limit: 10 });
    expect(runs.map((r) => r.id)).toContain('run1');
  });
});

describe('parseDurationMs', () => {
  it('parses compact single-unit durations', () => {
    expect(parseDurationMs('90s')).toBe(90_000);
    expect(parseDurationMs('15m')).toBe(15 * 60_000);
    expect(parseDurationMs('4h')).toBe(4 * 3_600_000);
    expect(parseDurationMs('2d')).toBe(2 * 86_400_000);
    expect(parseDurationMs('500ms')).toBe(500);
  });

  it('returns undefined for junk input, letting callers fall back to a default', () => {
    expect(parseDurationMs('15mins')).toBeUndefined();
    expect(parseDurationMs('soon')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();
  });
});

describe('attachLiveness / filterStale — telling "working" apart from "stranded"', () => {
  it('reports no stale pending step for a healthy completed run', async () => {
    const { store, engine } = makeEngine();
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');
    const [live] = await attachLiveness(store, await store.listRuns({}));
    expect(live?.stalePending).toBeNull();
    expect(live?.recoveryAttempts).toBe(0);
  });

  it('finds the oldest pending remote checkpoint on a suspended run and ages it against `now`', async () => {
    const { store, enqueuedAt } = await makeStrandedRun();
    const run = await store.getRun('stuck1');
    expect(run?.status).toBe('suspended');

    const laterBySeconds = 20 * 60; // 20 minutes later — past the default 15m threshold
    const now = enqueuedAt + laterBySeconds * 1000;
    const [live] = await attachLiveness(store, [run as NonNullable<typeof run>], now);
    expect(live?.stalePending).toMatchObject({ name: 'ext.ping', attempts: 1 });
    expect(live?.stalePending?.ageMs).toBe(laterBySeconds * 1000);
  });

  it('--stale filters to runs whose pending step exceeds the threshold, others pass through clean', async () => {
    const { store: stuckStore, enqueuedAt: stuckEnqueuedAt } = await makeStrandedRun();
    const stuckRun = await stuckStore.getRun('stuck1');

    const { store: freshStore, enqueuedAt: freshEnqueuedAt } = await makeStrandedRun();
    const freshRun = await freshStore.getRun('stuck1');

    const stuckLive = await attachLiveness(
      stuckStore,
      [stuckRun as NonNullable<typeof stuckRun>],
      stuckEnqueuedAt + 20 * 60_000, // 20 minutes later
    );
    // "fresh" one is checked only 1 minute after dispatch — well under the default threshold.
    const freshLive = await attachLiveness(
      freshStore,
      [freshRun as NonNullable<typeof freshRun>],
      freshEnqueuedAt + 60_000,
    );

    expect(filterStale(stuckLive, DEFAULT_STALE_MS)).toHaveLength(1);
    expect(filterStale(freshLive, DEFAULT_STALE_MS)).toHaveLength(0);
  });

  it('a pending step with a FRESH worker heartbeat is alive, not stranded — however old', async () => {
    const { store, enqueuedAt } = await makeStrandedRun();
    const run = await store.getRun('stuck1');
    const now = enqueuedAt + 40 * 60_000; // 40 minutes in flight — a long browser batch, say

    // The worker beat 10 seconds ago: mid-flight and healthy.
    const [cp] = await store.listCheckpoints('stuck1');
    await store.recordStepHeartbeat?.('stuck1', cp!.seq, new Date(now - 10_000), { done: 38 });
    const beating = await attachLiveness(store, [run as NonNullable<typeof run>], now);
    expect(beating[0]?.stalePending?.heartbeatAgeMs).toBe(10_000);
    expect(filterStale(beating, DEFAULT_STALE_MS)).toHaveLength(0);

    // The same step SILENT past the threshold flips back to stranded.
    await store.recordStepHeartbeat?.('stuck1', cp!.seq, new Date(now - 16 * 60_000));
    const silent = await attachLiveness(store, [run as NonNullable<typeof run>], now);
    expect(filterStale(silent, DEFAULT_STALE_MS)).toHaveLength(1);
  });

  it('renders the PENDING column with age + attempts for a stranded run', async () => {
    const { store, enqueuedAt } = await makeStrandedRun();
    const run = await store.getRun('stuck1');
    const now = enqueuedAt + 90 * 60_000; // 1h30m later
    const live = await attachLiveness(store, [run as NonNullable<typeof run>], now);
    const rendered = renderRunsTable(live);
    expect(rendered).toContain('1h30m');
    expect(rendered).toContain('attempt 1');
  });
});

describe('staleHint', () => {
  it('points at both recovery paths that actually exist', () => {
    const hint = staleHint('stuck1');
    expect(hint).toContain("engine.redispatchPending('stuck1')");
    expect(hint).toContain('node ace durable:retry stuck1');
  });
});

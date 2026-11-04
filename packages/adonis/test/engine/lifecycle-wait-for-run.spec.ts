import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError, SignalTimeoutError } from '../../src/errors.js';
import type { WorkflowLifecycleEvent } from '../../src/lifecycle-events.js';
import { runWaitPrefix } from '../../src/lifecycle-events.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));

function setup(clock?: () => number) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, ...(clock ? { clock } : {}) });
  // The target: completes with its input once signalled, or fails on demand.
  engine.register('ingest', '1', async (ctx, input) => {
    const { fail } = await ctx.waitForSignal<{ fail?: boolean }>(`go:${ctx.runId}`);
    if (fail) throw new FatalError('bad file', 'bad_file');
    return { rows: (input as { rows: number }).rows };
  });
  const seen: WorkflowLifecycleEvent[] = [];
  engine.register('watcher', '1', async (ctx, input) => {
    const event = await ctx.waitForRun<{ rows: number }>((input as { target: string }).target);
    seen.push(event);
    return event.status;
  });
  return { store, engine, seen };
}

describe('ctx.waitForRun', () => {
  it('resolves at once for a run that settled before the wait', async () => {
    const { store, engine, seen } = setup();
    await engine.start('ingest', { rows: 2 }, 'i1');
    await engine.signal('go:i1', {});
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');

    const result = await startRun(engine, 'watcher', { target: 'i1' }, 'w1');
    expect(result.status).toBe('completed');
    expect(seen).toEqual([
      expect.objectContaining({
        runId: 'i1',
        workflow: 'ingest',
        status: 'completed',
        output: { rows: 2 },
      }),
    ]);
    expect(await store.listSignalWaiters(runWaitPrefix('i1'))).toEqual([]);
  });

  it('suspends until the run settles, then resumes with its event', async () => {
    const { store, engine, seen } = setup();
    await engine.start('ingest', { rows: 3 }, 'i1');
    expect((await startRun(engine, 'watcher', { target: 'i1' }, 'w1')).status).toBe('suspended');

    await engine.signal('go:i1', {});
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
    expect(seen).toEqual([expect.objectContaining({ runId: 'i1', output: { rows: 3 } })]);
  });

  it('resolves with the error of a run that failed', async () => {
    const { store, engine, seen } = setup();
    await engine.start('ingest', { rows: 3 }, 'i1');
    await startRun(engine, 'watcher', { target: 'i1' }, 'w1');

    await engine.signal('go:i1', { fail: true });
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
    expect((await store.getRun('w1'))?.output).toBe('failed');
    expect(seen[0]).toMatchObject({ status: 'failed', error: { message: 'bad file' } });
    expect(seen[0]).not.toHaveProperty('output');
  });

  it('records the event, so a replay of the waiter does not read the target again', async () => {
    const { store, engine } = setup();
    let replays = 0;
    engine.register('twice', '1', async (ctx) => {
      const event = await ctx.waitForRun('i1');
      replays += 1;
      await ctx.sleep(1);
      return event.status;
    });
    await engine.start('ingest', { rows: 1 }, 'i1');
    await engine.signal('go:i1', {});
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    expect((await startRun(engine, 'twice', {}, 't1')).status).toBe('suspended');
    // The target disappears; the waiter's replay reads the event from its checkpoint.
    await store.deleteRun('i1');
    await poll(async () => {
      await engine.resumeDueTimers(Date.now() + 10_000);
      return (await store.getRun('t1'))?.status === 'completed';
    });
    // Completing with the target deleted is the proof: a replay that read the target would fail
    // with run_not_found. How many turns replayed the body depends on timer scheduling.
    expect((await store.getRun('t1'))?.output).toBe('completed');
    expect(replays).toBeGreaterThanOrEqual(2);
  });

  it('throws SignalTimeoutError when the run does not settle in time', async () => {
    let now = 1_000;
    const { engine, store } = setup(() => now);
    engine.register('bounded', '1', async (ctx) => {
      try {
        await ctx.waitForRun('i1', { timeoutMs: '5s' });
        return 'settled';
      } catch (e) {
        if (e instanceof SignalTimeoutError) return 'timed-out';
        throw e;
      }
    });
    await engine.start('ingest', { rows: 1 }, 'i1');
    expect((await startRun(engine, 'bounded', {}, 'b1')).status).toBe('suspended');

    now = 7_000;
    await engine.resumeDueTimers(now);
    expect((await store.getRun('b1'))?.output).toBe('timed-out');
    expect(await store.listSignalWaiters(runWaitPrefix('i1'))).toEqual([]);
  });

  it('fails the waiting run, without retrying, for an unknown run id', async () => {
    const { store, engine } = setup();
    await startRun(engine, 'watcher', { target: 'nope' }, 'w1');
    const run = await store.getRun('w1');
    expect(run?.status).toBe('failed');
    expect(run?.error?.message).toBe('run nope not found');
    expect(await store.listSignalWaiters(runWaitPrefix('nope'))).toEqual([]);
  });

  it('is woken by the lifecycle sweep when the settle notification was lost', async () => {
    const { store, engine, seen } = setup();
    await engine.start('ingest', { rows: 4 }, 'i1');
    await startRun(engine, 'watcher', { target: 'i1' }, 'w1');
    // The target settles without this engine noticing (another process died after the write).
    await store.updateRun('i1', { status: 'completed', output: { rows: 4 } });
    await settle();
    expect((await store.getRun('w1'))?.status).toBe('suspended');

    expect(await engine.sweepLifecycleEvents()).toBe(1);
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
    expect(seen).toEqual([expect.objectContaining({ runId: 'i1', output: { rows: 4 } })]);
  });

  it('follows a continue-as-new chain to the run that ends it', async () => {
    const { store, engine, seen } = setup();
    engine.register('counter', '1', async (ctx, input) => {
      const n = (input as { n: number }).n;
      if (n === 1) await ctx.waitForSignal('go:counter');
      if (n < 3) await ctx.continueAsNew({ n: n + 1 });
      return { n };
    });
    await engine.start('counter', { n: 1 }, 'c');
    expect((await startRun(engine, 'watcher', { target: 'c' }, 'w1')).status).toBe('suspended');

    await engine.signal('go:counter', {});
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
    expect(seen).toEqual([
      expect.objectContaining({ runId: 'c~2', status: 'completed', output: { n: 3 } }),
    ]);

    // A wait registered after the chain ended resolves from its last run at once.
    expect((await startRun(engine, 'watcher', { target: 'c' }, 'w2')).status).toBe('completed');
    expect(seen[1]).toMatchObject({ runId: 'c~2', output: { n: 3 } });
  });

  it('waits on a run whose id holds the token separator', async () => {
    const { store, engine } = setup();
    await engine.start('ingest', { rows: 1 }, 'a#b');
    await startRun(engine, 'watcher', { target: 'a#b' }, 'w1');
    await engine.signal('go:a#b', {});
    await poll(async () => (await store.getRun('w1'))?.status === 'completed');
  });
});

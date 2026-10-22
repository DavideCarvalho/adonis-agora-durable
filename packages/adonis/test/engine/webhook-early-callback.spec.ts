import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { SignalWaiter } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** Pauses the next `putSignalWaiter` until released, so a callback can land in that exact window. */
class GatedStateStore extends InMemoryStateStore {
  private gate: { reached: () => void; release: Promise<void> } | undefined;

  armPut(): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    const releaseP = new Promise<void>((r) => {
      release = r;
    });
    this.gate = { reached, release: releaseP };
    return { reached: reachedP, release };
  }

  override async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    const gate = this.gate;
    if (gate) {
      this.gate = undefined;
      gate.reached();
      await gate.release;
    }
    await super.putSignalWaiter(waiter);
  }
}

describe('ctx.webhook — a callback that arrives before wait()', () => {
  it('an unbounded wait() consumes a callback delivered while the run was still before it', async () => {
    let now = 1_000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('wf', '1', async (ctx) => {
      const wh = ctx.webhook<{ ok: boolean }>();
      await ctx.localStep('hand-out-url', async () => wh.token);
      await ctx.sleep('10s'); // the run is parked BEFORE wait() when the provider calls back
      return wh.wait();
    });

    const first = await startRun(engine, 'wf', {}, 'r1');
    expect(first.status).toBe('suspended');

    // The callback beats the wait: nobody waits yet, so the engine buffers it.
    expect(await engine.signal('wh:r1:0', { ok: true })).toBeNull();

    now = 20_000;
    await engine.resumeDueTimers(now);
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ ok: true });
    expect(await store.takeBufferedSignal('wh:r1:0')).toBeNull(); // consumed, not left behind
    expect(await store.listSignalWaiters('wh:r1:0')).toEqual([]);
  });

  it('a bounded wait({ timeoutMs }) consumes an early callback too', async () => {
    let now = 1_000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('wf', '1', async (ctx) => {
      const wh = ctx.webhook<{ ok: boolean }>();
      await ctx.sleep('10s');
      return wh.wait({ timeoutMs: 60_000 });
    });

    await startRun(engine, 'wf', {}, 'r2');
    expect(await engine.signal('wh:r2:0', { ok: true })).toBeNull();
    now = 20_000;
    await engine.resumeDueTimers(now);
    const run = await store.getRun('r2');
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ ok: true });
  });

  it('race: a callback landing between the buffer check and the waiter registration is not lost', async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async (ctx) => ctx.webhook<{ by: string }>().wait());

    const gate = store.armPut();
    const resultPromise = startRun(engine, 'wf', {}, 'r3');
    await gate.reached; // paused right before wait() registers its waiter

    expect(await engine.signal('wh:r3:0', { by: 'provider' })).toBeNull(); // buffered

    gate.release();
    const result = await resultPromise;
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ by: 'provider' });
    expect(await store.listSignalWaiters('wh:r3:0')).toEqual([]);
  });

  it('race (bounded): the same window is closed with a timeout', async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store, clock: () => 1_000 });
    engine.register('wf', '1', async (ctx) =>
      ctx.webhook<{ by: string }>().wait({ timeoutMs: 60_000 }),
    );

    const gate = store.armPut();
    const resultPromise = startRun(engine, 'wf', {}, 'r4');
    await gate.reached;
    expect(await engine.signal('wh:r4:0', { by: 'provider' })).toBeNull();
    gate.release();
    const result = await resultPromise;
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ by: 'provider' });
  });
});

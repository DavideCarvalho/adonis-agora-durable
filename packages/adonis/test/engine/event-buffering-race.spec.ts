import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { SignalWaiter } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Reliable (buffered) EVENTS — the events-side counterpart of signal-waiter-race.spec.ts's coverage.
 * Before this, `engine.publishEvent` DROPPED a publish that matched no live waiter, and
 * `ctx.waitForEvent` never consulted any buffer — the same lost-wake class of bug the signal fix
 * closed, just unfixed for events. `GatedStateStore` makes the race windows deterministic.
 *
 * NOTE: the crash-recovery reconcile sweep + `eventBufferTtlMs` pruning (source
 * `reconcileBufferedEvent`) are NOT ported — this engine has no `reconcileMs` fallback-wakeAt so an
 * unbounded event wait never appears in `resumeDueTimers`. The live-path windows below are all closed.
 */
class GatedStateStore extends InMemoryStateStore {
  private readonly gates = new Map<
    string,
    { reachedResolve: () => void; releasePromise: Promise<void> }
  >();

  arm(hook: string): { reached: Promise<void>; release: () => void } {
    let reachedResolve!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    let releaseResolve!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    this.gates.set(hook, { reachedResolve, releasePromise });
    return { reached, release: releaseResolve };
  }

  private async pause(hook: string): Promise<void> {
    const gate = this.gates.get(hook);
    if (!gate) return;
    this.gates.delete(hook);
    gate.reachedResolve();
    await gate.releasePromise;
  }

  override async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    await this.pause('beforePutSignalWaiter');
    await super.putSignalWaiter(waiter);
  }

  override async bufferEvent(input: {
    name: string;
    payload: unknown;
    id: string;
    publishedAt: number;
  }): Promise<void> {
    await this.pause('beforeBufferEvent');
    await super.bufferEvent(input);
  }
}

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitUntil timed out');
}

describe('event buffering — publish-before-wait reliability', () => {
  it('a publish with no live waiter buffers, and a later matching waitForEvent consumes it', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ decision: string }>('order.decided', {
        match: { decision: 'approved' },
      }),
    );

    const touched = await engine.publishEvent('order.decided', { decision: 'approved' });
    expect(touched).toBe(0); // nobody was waiting yet — buffered, not delivered live

    const result = await startRun(engine, 'approval', {}, 'r1');
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ decision: 'approved' });
    expect(await store.listBufferedEvents('order.decided', 10)).toEqual([]); // consumed
  });

  it('a match-rejecting waiter does NOT consume a buffered event it does not accept', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('rejector', '1', async (ctx) =>
      ctx.waitForEvent<{ decision: string }>('order.decided', { match: { decision: 'rejected' } }),
    );

    await engine.publishEvent('order.decided', { decision: 'approved' });
    const result = await startRun(engine, 'rejector', {}, 'r1');
    expect(result.status).toBe('suspended'); // the buffered payload doesn't match — left untouched
    expect(await store.listBufferedEvents('order.decided', 10)).toEqual([
      {
        id: expect.any(String),
        payload: { decision: 'approved' },
        publishedAt: expect.any(Number),
      },
    ]);
  });

  it('point-to-point redelivery: once a matching waiter claims the buffered copy, a second matching waiter gets nothing', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approver', '1', async (ctx) =>
      ctx.waitForEvent<{ decision: string }>('order.decided', { match: { decision: 'approved' } }),
    );

    await engine.publishEvent('order.decided', { decision: 'approved' });

    const first = await startRun(engine, 'approver', {}, 'r1');
    expect(first.status).toBe('completed');
    expect(first.output).toEqual({ decision: 'approved' });

    // Nothing left buffered — the second matching waiter suspends instead of double-consuming.
    const second = await startRun(engine, 'approver', {}, 'r2');
    expect(second.status).toBe('suspended');
  });

  it('opts.buffer === false opts out of buffering entirely', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approver', '1', async (ctx) => ctx.waitForEvent('order.decided'));

    const touched = await engine.publishEvent(
      'order.decided',
      { decision: 'approved' },
      { buffer: false },
    );
    expect(touched).toBe(0);
    expect(await store.listBufferedEvents('order.decided', 10)).toEqual([]); // nothing buffered

    const result = await startRun(engine, 'approver', {}, 'r1');
    expect(result.status).toBe('suspended'); // nothing to consume
  });
});

describe('event buffering — live fan-out stays live-only', () => {
  it('a publish that resumes ≥1 live waiter is NOT buffered', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('waiter', '1', async (ctx) => ctx.waitForEvent<{ n: number }>('tick'));

    // Each start is awaited to full suspension before the next — publishing while a turn is STILL
    // unwinding is a separate race, not what this case is about.
    const r1 = await startRun(engine, 'waiter', {}, 'r1');
    expect(r1.status).toBe('suspended');
    const r2 = await startRun(engine, 'waiter', {}, 'r2');
    expect(r2.status).toBe('suspended');

    const touched = await engine.publishEvent('tick', { n: 7 });
    expect(touched).toBe(2); // both live waiters resumed

    expect((await engine.waitForRun('r1')).output).toEqual({ n: 7 });
    expect((await engine.waitForRun('r2')).output).toEqual({ n: 7 });
    expect(await store.listBufferedEvents('tick', 10)).toEqual([]); // fan-out, not buffered
  });
});

describe('event buffering — interleaving windows (the lost-wake race, closed)', () => {
  it("waiter registers, THEN a concurrent publish finds no waiter yet and buffers — the waiter's own post-register scan catches it", async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ ok: boolean }>('go', { match: { ok: true } }),
    );

    // Pause the run's own waiter registration — so when the publish below runs, NOTHING is registered
    // yet, exactly the window the bug lived in.
    const gate = store.arm('beforePutSignalWaiter');
    const resultPromise = startRun(engine, 'approval', {}, 'r1');
    await gate.reached;

    const touched = await engine.publishEvent('go', { ok: true });
    expect(touched).toBe(0); // no live waiter yet — buffered instead of dropped

    // Release: putSignalWaiter completes, then the fix's post-register buffer scan runs and must find
    // the payload we just buffered — resolving instead of suspending forever.
    gate.release();
    const result = await resultPromise;
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ ok: true });
    expect(await store.listSignalWaiters('event:')).toEqual([]); // its own waiter row was cleaned up
  });

  it("mirror-image window: a waiter registers between publishEvent's initial miss and its buffer write", async () => {
    const store = new GatedStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('approval', '1', async (ctx) =>
      ctx.waitForEvent<{ ok: boolean }>('go', { match: { ok: true } }),
    );

    // publishEvent's initial listSignalWaiters finds nothing, then pauses RIGHT BEFORE it writes the buffer.
    const gate = store.arm('beforeBufferEvent');
    const publishPromise = engine.publishEvent('go', { ok: true });
    await gate.reached;

    // The waiter registers (and, since nothing is buffered yet at its own scan, suspends) WHILE
    // publishEvent is paused mid-delivery. Fire-and-forget via `engine.start`.
    await engine.start('approval', {}, 'r1');
    await waitUntil(async () => (await store.listSignalWaiters('event:')).length > 0);

    // Release: publishEvent buffers, then re-checks listSignalWaiters — finds the waiter that
    // registered in the window — and reclaims + delivers instead of leaving both rows stranded.
    gate.release();
    const touched = await publishPromise;
    expect(touched).toBe(1);
    const result = await store.getRun('r1');
    expect(result?.status).toBe('completed');
    expect(result?.output).toEqual({ ok: true });
    expect(await store.listSignalWaiters('event:')).toEqual([]);
    expect(await store.listBufferedEvents('go', 10)).toEqual([]);
  });
});

describe('event buffering — determinism', () => {
  it('consuming a buffered event lands at the SAME logical position as a live delivery (no seq drift)', async () => {
    async function run(mode: 'live' | 'buffered'): Promise<{ status: string; output: unknown }> {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      engine.register('flow', '1', async (ctx) => {
        const evt = await ctx.waitForEvent<{ n: number }>('go');
        return ctx.localStep('double', async () => evt.n * 2);
      });
      if (mode === 'buffered') {
        await engine.publishEvent('go', { n: 21 });
        const result = await startRun(engine, 'flow', {}, 'r1');
        return { status: result.status, output: result.output };
      }
      const suspended = await startRun(engine, 'flow', {}, 'r1');
      expect(suspended.status).toBe('suspended'); // fully unwound before the live publish below
      await engine.publishEvent('go', { n: 21 });
      const result = await engine.waitForRun('r1');
      return { status: result.status, output: result.output };
    }

    const live = await run('live');
    const buffered = await run('buffered');
    expect(live).toEqual(buffered);
    expect(buffered).toEqual({ status: 'completed', output: 42 });
  });
});

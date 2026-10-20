import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

async function poll(fn: () => Promise<boolean> | boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('requeue of a FAILED run resets its failure state so replay re-executes', () => {
  it('an exhausted-failed REMOTE step re-dispatches on retry instead of rethrowing in milliseconds', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let attempts = 0;
    let healthy = false;
    transport.handle('ext.step', async () => {
      attempts += 1;
      if (!healthy) throw new Error('worker wedged');
      return 'ok';
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('wf', '1', async (ctx) => ctx.step<string>('ext.step', {}));

    await engine.start('wf', {}, 'r1');
    await flush();
    expect(attempts).toBe(1); // default retries: the single attempt is exhausted
    expect((await store.getRun('r1'))?.status).toBe('failed');

    // Before the reset, requeue replayed straight into the exhausted-failed checkpoint and
    // re-failed without ever re-dispatching (attempts stayed 1).
    healthy = true;
    nowMs += 1;
    await engine.requeue('r1');
    await flush();

    await poll(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(attempts).toBe(2); // the step actually RE-RAN
    expect((await store.getRun('r1'))?.output).toBe('ok');
  });

  it('parent failed by a child failure: retry parent THEN child — parent resumes on the child completion', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let healthy = false;
    transport.handle('ext.child-step', async () => {
      if (!healthy) throw new Error('boom');
      return 'child-ok';
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('child', '1', async (ctx) => ctx.step<string>('ext.child-step', {}));
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child<string>('child', {});
      return `parent saw ${out}`;
    });

    await engine.start('parent', {}, 'p1');
    await flush();
    expect((await store.getRun('p1.child.0'))?.status).toBe('failed');
    await poll(async () => (await store.getRun('p1'))?.status === 'failed');

    healthy = true;
    nowMs += 1;
    // Parent first: its child-signal FAILURE completion resets to the live placeholder AND the
    // failed child is CASCADE-requeued (parent-only used to suspend forever in a live engine —
    // the reconciler re-delivered the child's still-failed terminal state within seconds).
    await engine.requeue('p1');
    await flush();
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toBe('parent saw child-ok');

    // A redundant manual child requeue afterwards is harmless (completed-run replay short-circuits).
    await engine.requeue('p1.child.0');
    await flush();
    expect((await store.getRun('p1.child.0'))?.status).toBe('completed');
  });

  it('or retry child THEN parent — the buffered child completion is consumed on the parent replay', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let healthy = false;
    transport.handle('ext.child-step2', async () => {
      if (!healthy) throw new Error('boom');
      return 'child-ok';
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('child', '1', async (ctx) => ctx.step<string>('ext.child-step2', {}));
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child<string>('child', {});
      return `parent saw ${out}`;
    });

    await engine.start('parent', {}, 'p2');
    await flush();
    await poll(async () => (await store.getRun('p2'))?.status === 'failed');

    healthy = true;
    nowMs += 1;
    await engine.requeue('p2.child.0');
    await flush();
    await poll(async () => (await store.getRun('p2.child.0'))?.status === 'completed');

    await engine.requeue('p2');
    await flush();

    await poll(async () => (await store.getRun('p2'))?.status === 'completed');
    expect((await store.getRun('p2'))?.output).toBe('parent saw child-ok');
  });

  it('CASCADE: requeue of the parent alone also requeues its failed awaited child — the pair converges', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let healthy = false;
    transport.handle('ext.cascade-step', async () => {
      if (!healthy) throw new Error('boom');
      return 'child-ok';
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('child', '1', async (ctx) => ctx.step<string>('ext.cascade-step', {}));
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child<string>('child', {});
      return `parent saw ${out}`;
    });

    await engine.start('parent', {}, 'pc');
    await flush();
    await poll(async () => (await store.getRun('pc'))?.status === 'failed');
    expect((await store.getRun('pc.child.0'))?.status).toBe('failed');

    healthy = true;
    nowMs += 1;
    await engine.requeue('pc'); // ONE call — the dashboard "Retry parent" gesture
    await flush();

    await poll(async () => (await store.getRun('pc'))?.status === 'completed');
    expect((await store.getRun('pc.child.0'))?.status).toBe('completed');
    expect((await store.getRun('pc'))?.output).toBe('parent saw child-ok');
  });

  it('a ctx.all parent failed by one child: requeue converges on the retried child', async () => {
    const store = new InMemoryStateStore();
    let healthy = false;
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (ctx, input) => {
      const i = (input as { i: number }).i;
      if (i === 1 && !healthy) throw new Error('boom');
      // The retried child settles only once the parent has suspended on it again.
      if (i === 1) await ctx.waitForSignal('go');
      return i;
    });
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>('child', [{ i: 0 }, { i: 1 }, { i: 2 }]),
    );

    await engine.start('parent', {}, 'p');
    await poll(async () => (await store.getRun('p'))?.status === 'failed');

    healthy = true;
    await engine.requeue('p');
    await poll(async () => (await store.listSignalWaiters('go')).length === 1);
    await poll(async () => (await store.getRun('p'))?.status === 'suspended');
    await engine.signal('go', undefined);
    await poll(async () => (await store.getRun('p'))?.status === 'completed');
    expect((await store.getRun('p'))?.output).toEqual([0, 1, 2]);
    expect(await store.listSignalWaiters('child:p.')).toEqual([]);
  });

  it("a ctx.all parent adopts a fan child's retry-with-input SUCCESS without re-running the origin", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, reconcileMs: 0 });
    engine.register('child', '1', async (_ctx, input) => {
      const { i, fixed } = input as { i: number; fixed?: boolean };
      if (i === 1 && !fixed) throw new Error('bad input');
      return i * 10;
    });
    engine.register('parent', '1', async (ctx) =>
      ctx.all<number>('child', [{ i: 0 }, { i: 1 }, { i: 2 }]),
    );

    await engine.start('parent', {}, 'pf');
    await poll(async () => (await store.getRun('pf'))?.status === 'failed');
    const retried = await engine.retryWithInput('pf.all.0.1', { i: 1, fixed: true });
    await poll(async () => (await store.getRun(retried?.runId ?? ''))?.status === 'completed');

    await engine.requeue('pf');
    await poll(async () => (await store.getRun('pf'))?.status === 'completed');
    expect((await store.getRun('pf'))?.output).toEqual([0, 10, 20]);
    expect((await store.getRun('pf.all.0.1'))?.status).toBe('failed');
    expect(await store.listSignalWaiters('child:pf.')).toEqual([]);
    expect(await store.takeBufferedSignal('child:pf.all.0.1')).toBeNull();
  });

  it('requeue CLEARS the stale run.error while the run re-executes', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('ext.always-fails', async () => {
      throw new Error('permanent');
    });
    const engine = new WorkflowEngine({ store, transport });
    engine.register('wf', '1', async (ctx) => ctx.step('ext.always-fails', {}));

    await engine.start('wf', {}, 'rf');
    await flush();
    await poll(async () => (await store.getRun('rf'))?.status === 'failed');
    expect((await store.getRun('rf'))?.error).toBeTruthy();

    await engine.requeue('rf');
    // Immediately after requeue (before the re-execution fails again) the stale error is GONE.
    expect((await store.getRun('rf'))?.status).toBe('pending');
    expect((await store.getRun('rf'))?.error).toBeUndefined();
  });

  it("a retry-with-input run's SUCCESS also lands on the ORIGIN's token, so the parent adopts it", async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    let healthy = false;
    transport.handle('ext.adopt-step', async (input: unknown) => {
      if (!healthy) throw new Error('bad input');
      return `ok:${JSON.stringify(input)}`;
    });
    let nowMs = 1000;
    const engine = new WorkflowEngine({ store, transport, clock: () => nowMs });
    engine.register('child', '1', async (ctx, input) => ctx.step<string>('ext.adopt-step', input));
    engine.register('parent', '1', async (ctx) => {
      const out = await ctx.child<string>('child', { v: 1 });
      return `parent saw ${out}`;
    });

    await engine.start('parent', {}, 'pa');
    await flush();
    await poll(async () => (await store.getRun('pa'))?.status === 'failed');

    // Fix-and-replay the failed child with corrected input: a STANDALONE `<origin>~retry~` run.
    healthy = true;
    nowMs += 1;
    const retried = await engine.retryWithInput('pa.child.0', { v: 2 });
    expect(retried?.runId).toContain('~retry~');
    await flush();
    await poll(async () => (await store.getRun(retried?.runId ?? ''))?.status === 'completed');

    // Retrying the parent now consumes the retry's success (delivered on the ORIGIN token,
    // buffered) — the parent completes without anyone re-running the origin child.
    nowMs += 1;
    await engine.requeue('pa');
    await flush();
    await poll(async () => (await store.getRun('pa'))?.status === 'completed');
    expect((await store.getRun('pa'))?.output).toBe('parent saw ok:{"v":2}');
    // The buffered retry success suppressed the cascade: the failed ORIGIN child was NOT re-run.
    expect((await store.getRun('pa.child.0'))?.status).toBe('failed');
  });

  it('requeue of a non-failed run is unchanged (no checkpoint mutation)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('w', '1', async (ctx) => ctx.localStep('s', async () => 'ok'));
    await engine.start('w', {}, 'r1');
    await engine.runPending();
    expect((await store.getRun('r1'))?.status).toBe('completed');

    await engine.requeue('r1'); // requeue of a completed run: replay short-circuits, stays completed
    const [res] = await engine.runPending();
    expect(res?.status).toBe('completed');
  });
});

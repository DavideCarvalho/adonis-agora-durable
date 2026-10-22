import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('child start failure surfaces on the parent', () => {
  it('an awaited child of an unregistered workflow FAILS the parent instead of hanging suspended', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    // No 'processing' registration and no transport (so convention routing finds no live group):
    // `this.start('processing', ...)` inside the deferred child start throws "not registered". Before
    // the fix that throw was swallowed (`.catch(() => undefined)`) and the parent sat suspended
    // forever, silently re-attempting on every recovery wake.
    engine.register('parent', '1', async (ctx) => {
      await ctx.child('processing', {});
      return 'unreachable';
    });

    await engine.start('parent', {}, 'p1');

    await poll(async () => (await store.getRun('p1'))?.status === 'failed');

    const run = await store.getRun('p1');
    expect(run?.status).toBe('failed');
    // The cause chain survives: both the child-start framing and the underlying registration error.
    const error = JSON.stringify(run?.error);
    expect(error).toContain('failed to start');
    expect(error).toContain('not registered');
    // The child run was never created.
    expect(await store.getRun('p1.child.0')).toBeFalsy();
  });

  it('a fire-and-forget spawn of an unregistered workflow does not fail the parent, but a later join by id observes the failed start', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('parent', '1', async (ctx) => {
      // Spawn (no waiter): the start failure is buffered on `child:<id>`.
      const id = await ctx.startChild('processing', {});
      // Join by the same id: consumes the buffered failure and throws.
      await ctx.child('processing', {}, id);
      return 'unreachable';
    });

    await engine.start('parent', {}, 'p2');

    await poll(async () => (await store.getRun('p2'))?.status === 'failed');

    const run = await store.getRun('p2');
    expect(run?.status).toBe('failed');
    expect(JSON.stringify(run?.error)).toContain('failed to start');
  });
});

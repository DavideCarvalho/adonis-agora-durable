import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

describe('saga compensation', () => {
  it('runs compensations in reverse for completed steps when the run fails', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const undone: string[] = [];
    engine.register('saga', '1', async (ctx) => {
      await ctx.localStep('a', async () => 'A', { compensate: async () => void undone.push('a') });
      await ctx.localStep('b', async () => 'B', { compensate: async () => void undone.push('b') });
      await ctx.localStep('c', async () => {
        throw new Error('boom');
      });
    });

    const res = await startRun(engine, 'saga', {}, 'r1');
    expect(res.status).toBe('failed');
    expect(undone).toEqual(['b', 'a']); // reverse, only the completed steps
  });

  it('does not compensate when the run succeeds', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const undone: string[] = [];
    engine.register('ok', '1', async (ctx) => {
      await ctx.localStep('a', async () => 'A', { compensate: async () => void undone.push('a') });
      return 'done';
    });
    const res = await startRun(engine, 'ok', {}, 'r2');
    expect(res.status).toBe('completed');
    expect(undone).toEqual([]);
  });
});

describe('ctx.child (child workflows)', () => {
  it('runs a child and resumes the parent with its output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async () => ({ doubled: 42 }));
    engine.register('parent', '1', async (ctx) => {
      const r = await ctx.child<{ doubled: number }>('child', {});
      return r.doubled;
    });

    const first = await startRun(engine, 'parent', {}, 'p1');
    expect(first.status).toBe('suspended');

    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toBe(42);
  });

  it('propagates a child failure to the parent', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('badchild', '1', async () => {
      throw new Error('child boom');
    });
    engine.register('parent2', '1', async (ctx) => ctx.child('badchild', {}));

    await startRun(engine, 'parent2', {}, 'p2');
    await poll(async () => (await store.getRun('p2'))?.status === 'failed');
    expect((await store.getRun('p2'))?.error?.message).toContain('child boom');
  });
});

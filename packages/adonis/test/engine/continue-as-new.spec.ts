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

describe('ctx.continueAsNew', () => {
  it('completes the run and starts a fresh one (id ~N) with the new input', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const seen: number[] = [];

    engine.register('counter', '1', async (ctx, input) => {
      const n = (input as { n: number }).n;
      seen.push(n);
      await ctx.localStep(`work-${n}`, async () => n);
      if (n < 3) await ctx.continueAsNew({ n: n + 1 });
      return `done at ${n}`;
    });

    await engine.start('counter', { n: 1 }, 'c1');

    // c1 (n=1) → c1~1 (n=2) → c1~2 (n=3, returns)
    await poll(async () => (await store.getRun('c1~2'))?.status === 'completed');
    expect(seen).toEqual([1, 2, 3]);
    expect((await store.getRun('c1'))?.status).toBe('completed');
    expect((await store.getRun('c1~1'))?.status).toBe('completed');
    expect((await store.getRun('c1~2'))?.output).toBe('done at 3');
  });
});

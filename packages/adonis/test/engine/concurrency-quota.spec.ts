import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { ConcurrencyLimitError } from '../../src/errors.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { registerWorkflowClass } from '../../src/workflow-discovery.js';

function setup() {
  const store = new InMemoryStateStore();
  return { store, engine: new WorkflowEngine({ store }) };
}

describe('start-time concurrency quota', () => {
  it('derives the key and a per-key limit from the workflow config', async () => {
    const { engine } = setup();
    engine.register('turn', '1', async (ctx) => ctx.waitForSignal(`go:${ctx.runId}`), {
      concurrency: {
        key: (input) => `tenant:${(input as { tenant: string }).tenant}`,
        limit: async (key) => (key === 'tenant:big' ? 2 : 1),
      },
    });
    await engine.start('turn', { tenant: 'small' }, 's1');
    const err = await engine.start('turn', { tenant: 'small' }, 's2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConcurrencyLimitError);
    expect(err).toMatchObject({ key: 'tenant:small', limit: 1, active: 1, workflow: 'turn' });
    await engine.start('turn', { tenant: 'big' }, 'b1');
    await engine.start('turn', { tenant: 'big' }, 'b2');
    await expect(engine.start('turn', { tenant: 'big' }, 'b3')).rejects.toThrow(
      ConcurrencyLimitError,
    );
    await engine.drain();
  });

  it('countStatuses can leave runs parked on a human out of the count', async () => {
    const { engine } = setup();
    engine.register('a', '1', async (ctx) => ctx.waitForSignal('never'), {
      concurrency: { key: () => 'k', limit: 1, countStatuses: ['pending', 'running'] },
    });
    await engine.start('a', {}, 'a1');
    expect((await engine.waitForRun('a1')).status).toBe('suspended');
    await engine.start('a', {}, 'a2');
    await engine.drain();
  });

  it('an idempotent re-start is never rejected, and the quota tag is stamped', async () => {
    const { engine, store } = setup();
    engine.register('a', '1', async (ctx) => ctx.waitForSignal('never'));
    await engine.start('a', {}, 'same', { tags: ['mine'], concurrency: { key: 'k', limit: 1 } });
    await expect(
      engine.start('a', {}, 'same', { concurrency: { key: 'k', limit: 1 } }),
    ).resolves.toMatchObject({ runId: 'same' });
    expect((await store.getRun('same'))?.tags).toEqual(['mine', 'concurrency:k']);
    await engine.drain();
  });

  it('reads `static workflow = { concurrency }` off a discovered class', async () => {
    const { engine } = setup();
    class Capped {
      static workflow = {
        name: 'capped',
        concurrency: { key: (i: unknown) => (i as { t: string }).t, limit: 1 },
      };
      async run(ctx: { waitForSignal: (t: string) => Promise<unknown> }) {
        return ctx.waitForSignal('never');
      }
    }
    await registerWorkflowClass(engine, Capped, async (C) => new (C as typeof Capped)());
    await engine.start('capped', { t: 'x' }, 'c1');
    await expect(engine.start('capped', { t: 'x' }, 'c2')).rejects.toBeInstanceOf(
      ConcurrencyLimitError,
    );
    await engine.drain();
  });
});

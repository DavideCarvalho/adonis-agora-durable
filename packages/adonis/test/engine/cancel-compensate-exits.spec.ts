import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { ContinueAsNew } from '../../src/errors.js';
import type { WorkflowCtx } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function statusOf(store: InMemoryStateStore, id: string, want: string): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const s = (await store.getRun(id))?.status;
    if (s === want) return s;
    await new Promise((r) => setTimeout(r, 2));
  }
  return (await store.getRun(id))?.status ?? 'missing';
}

type Exit = 'returns' | 'throws' | 'continues-as-new';

/**
 * A compensating cancel issued while a turn is RUNNING used to be honored only if that turn (or the
 * resume queued behind it) stopped at a suspension point. A body that instead returned, threw or
 * continued-as-new settled `completed`/`failed` — the cancel was silently lost, its saga never undone.
 */
describe('compensating cancel is honored on every exit of the turn', () => {
  it.each(['returns', 'throws', 'continues-as-new'] as Exit[])(
    'a body that %s after the cancel still compensates and settles cancelled',
    async (exit) => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store });
      const undone: string[] = [];
      const inBody = gate();
      const release = gate();
      engine.register('saga', '1', async (ctx: WorkflowCtx, input) => {
        await ctx.localStep('reserve', async () => 'r', {
          compensate: async () => {
            undone.push('reserve');
          },
        });
        await ctx.localStep('work', async () => {
          inBody.open();
          await release.wait;
        });
        if (exit === 'throws') throw new Error('boom');
        if (exit === 'continues-as-new' && input === 'first') throw new ContinueAsNew('next');
        return 'done';
      });
      await engine.start('saga', 'first', 'r1');
      await inBody.wait;
      expect((await store.getRun('r1'))?.status).toBe('running');

      await engine.cancel('r1', { compensate: true });
      release.open();

      expect(await statusOf(store, 'r1', 'cancelled')).toBe('cancelled');
      expect(undone).toEqual(['reserve']);
      // No continuation was forked.
      expect(await store.getRun('r1~1')).toBeNull();
      await engine.drain();
    },
  );

  it.each(['returns', 'throws', 'continues-as-new', 'suspends'] as const)(
    'a cancel from ANOTHER pod while the turn runs is honored when the body %s',
    async (exit) => {
      const store = new InMemoryStateStore();
      // No marker: the persisted `cancelling` status is the only thing that reaches the owner's turn.
      const buffered: string[] = [];
      const buffer = store.bufferSignal.bind(store);
      store.bufferSignal = async (token, payload) => {
        buffered.push(token);
        return buffer(token, payload);
      };
      const owner = new WorkflowEngine({ store, instanceId: 'owner' });
      const operator = new WorkflowEngine({
        store,
        instanceId: 'operator',
        runDispatcher: { dispatch: () => {} },
      });
      const undone: string[] = [];
      const inBody = gate();
      const release = gate();
      for (const engine of [owner, operator]) {
        engine.register('saga', '1', async (ctx: WorkflowCtx, input) => {
          await ctx.localStep('reserve', async () => 'r', {
            compensate: async () => {
              undone.push('reserve');
            },
          });
          await ctx.localStep('work', async () => {
            inBody.open();
            await release.wait;
          });
          if (exit === 'throws') throw new Error('boom');
          if (exit === 'continues-as-new' && input === 'first') throw new ContinueAsNew('next');
          if (exit === 'suspends') await ctx.waitForSignal('never-sent');
          return 'done';
        });
      }
      await owner.start('saga', 'first', 'r1');
      await inBody.wait;
      // The operator pod holds no lease, and no in-memory flag or control message reaches the owner.
      await operator.cancel('r1', { compensate: true });
      expect((await store.getRun('r1'))?.status).toBe('cancelling');
      release.open();

      expect(await statusOf(store, 'r1', 'cancelled')).toBe('cancelled');
      expect(undone).toEqual(['reserve']);
      expect(await store.getRun('r1~1')).toBeNull();
      expect(buffered.filter((t) => t.startsWith('cancel:'))).toEqual([]);
      await owner.drain();
      await operator.drain();
    },
  );

  it('a run without a pending cancel completes normally', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('saga', '1', async () => 'done');
    await engine.start('saga', {}, 'r1');
    expect(await statusOf(store, 'r1', 'completed')).toBe('completed');
  });
});

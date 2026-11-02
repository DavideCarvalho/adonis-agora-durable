import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noDispatch = { dispatch: () => {} };
type Step = { localStep: (n: string, f: () => Promise<number>) => Promise<number> };

/**
 * `execute` lets an instance re-enter a lease it holds, and it judged that from the run it was handed. A resume reads
 * that run while the same instance's timer hand-off holds its short claim, the hand-off releases, and the turn starts
 * holding nothing: another instance locks the run and both execute.
 */
describe('a turn holding only a stale read of its own lease', () => {
  async function due(store: InMemoryStateStore, id: string, engine: WorkflowEngine) {
    await engine.start('flow', {}, id).catch(() => undefined);
    await sleep(20);
    await store.updateRun(id, { status: 'suspended', wakeAt: Date.now() - 1 });
    for (const cp of await store.listCheckpoints(id))
      await store.saveCheckpoint({ ...cp, status: 'running' });
    await store.releaseRunLock(id);
  }
  function counted(store: InMemoryStateStore, instanceId = 'a', stepMs = 0) {
    const steps = { n: 0, running: 0, most: 0 };
    const engine = new WorkflowEngine({
      store,
      instanceId,
      leaseMs: 5_000,
      runDispatcher: noDispatch,
    } as never);
    engine.register('flow', '1', (async (ctx: Step) =>
      ctx.localStep('work', async () => {
        steps.n += 1;
        steps.running += 1;
        steps.most = Math.max(steps.most, steps.running);
        await sleep(stepMs);
        steps.running -= 1;
        return 1;
      })) as never);
    return {
      engine,
      steps,
      inner: engine as unknown as Record<string, (id: string) => void> & {
        lockedForTurn: Set<string>;
      },
    };
  }

  it('does not run beside another instance', async () => {
    const store = new InMemoryStateStore();
    let stale: Awaited<ReturnType<InMemoryStateStore['getRun']>> | undefined;
    const reader = new Proxy(store, {
      get(target, key) {
        if (key === 'getRun' && stale) return async () => stale;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const running = { now: 0, most: 0 };
    const flow = (async (ctx: Step) =>
      ctx.localStep('work', async () => {
        running.now += 1;
        running.most = Math.max(running.most, running.now);
        await sleep(80);
        running.now -= 1;
        return 1;
      })) as never;
    const a = new WorkflowEngine({
      store: reader,
      instanceId: 'a',
      leaseMs: 5_000,
      runDispatcher: noDispatch,
    } as never);
    const b = new WorkflowEngine({
      store,
      instanceId: 'b',
      leaseMs: 5_000,
      runDispatcher: noDispatch,
    } as never);
    a.register('flow', '1', flow);
    b.register('flow', '1', flow);
    await store.createRun({
      id: 'r1',
      workflow: 'flow',
      workflowVersion: '1',
      status: 'suspended',
      input: {},
      wakeAt: Date.now() - 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    // The claim is held when the resume reads, and gone by the time the turn begins.
    expect(await store.tryLockRun('r1', 'a', Date.now() + 5_000, Date.now())).toBe(true);
    stale = await store.getRun('r1');
    await store.releaseRunLock('r1');
    const first = a.resume('r1');
    await sleep(5);
    stale = undefined;
    const second = b.resume('r1');
    await Promise.allSettled([first, second]);
    expect(running.most).toBe(1);
  });

  it('a turn that just locked runs even with a losing claim of this instance in flight', async () => {
    const store = new InMemoryStateStore();
    const { engine, steps, inner } = counted(store);
    await due(store, 'r2', engine);
    steps.n = 0;
    await store.updateRun('r2', { status: 'pending' });
    inner.markClaim?.call(engine, 'r2');
    const result = await engine.runOne('r2');
    inner.unmarkClaim?.call(engine, 'r2');
    expect(result?.status).toBe('completed');
    expect(steps.n).toBe(1);
  });

  it.each([
    ['still held', false],
    ['already over', true],
  ])(
    'a renewal that lands on a claim begun while it was out proves nothing: claim %s',
    async (_n, over) => {
      const shared = new InMemoryStateStore();
      let release: () => void = () => undefined;
      let sent = false;
      const held = new Proxy(shared, {
        get(target, key) {
          if (key === 'renewRunLock')
            return async (...args: [string, string, number]) => {
              sent = true;
              await new Promise<void>((r) => {
                release = r;
              });
              return shared.renewRunLock(...args);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const { engine, steps, inner } = counted(held as InMemoryStateStore);
      await due(shared, 'r3', engine);
      steps.n = 0;
      expect(await shared.tryLockRun('r3', 'a', Date.now() + 5_000, Date.now())).toBe(true);
      const turn = engine.resume('r3');
      await vi.waitFor(() => expect(sent).toBe(true));
      inner.markClaim?.call(engine, 'r3');
      if (over) inner.unmarkClaim?.call(engine, 'r3');
      release();
      await turn;
      expect(steps.n).toBe(0);
      if (!over) inner.unmarkClaim?.call(engine, 'r3');
    },
  );

  it('a mark for a turn that never reached execute is cleared', async () => {
    const store = new InMemoryStateStore();
    const { engine, inner } = counted(store);
    await engine.start('flow', {}, 'r4').catch(() => undefined);
    await sleep(20);
    await store.updateRun('r4', { status: 'completed' });
    await store.releaseRunLock('r4');
    await engine.runOne('r4');
    expect(inner.lockedForTurn?.size ?? 0).toBe(0);
  });
});

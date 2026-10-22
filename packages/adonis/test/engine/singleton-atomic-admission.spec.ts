import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { SingletonQueueFullError } from '../../src/errors.js';
import type { WorkflowDecision, WorkflowRun } from '../../src/interfaces.js';
import { SINGLETON_ADMITTED_TAG } from '../../src/singleton-admission.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const settle = async (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => Promise<boolean> | boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return;
    await settle();
  }
  throw new Error('condition never held');
}

const noDispatch = { dispatch: () => {} };

describe('singleton admission is an atomic, durable store claim', () => {
  afterEach(() => vi.useRealTimers());

  it('preserves an admitted holder when a later same-millisecond id sorts first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => 1000 });
    const entered: string[] = [];
    engine.register(
      'job',
      '1',
      async (ctx, input) => {
        await ctx.localStep('enter', async () => void entered.push(input as string));
        await ctx.waitForSignal(`release:${input as string}`);
      },
      { singleton: { key: () => 'k' } },
    );
    await startRun(engine, 'job', 'holder', 'z-holder');
    // Same createdAt, and `a-waiter` sorts BEFORE `z-holder` by id: a positional re-scan would admit
    // the waiter on top of the running holder. The durable slot keeps the holder's.
    await startRun(engine, 'job', 'waiter', 'a-waiter');
    expect(entered).toEqual(['holder']);
    expect((await store.getRun('a-waiter'))?.status).toBe('suspended');
    expect((await store.getRun('z-holder'))?.tags).toContain(SINGLETON_ADMITTED_TAG);
    await engine.drain();
  });

  it('two replicas never admit past the limit when an older run is picked up after a younger one', async () => {
    const store = new InMemoryStateStore();
    // Two engines over ONE store, both poll-driven (no inline dispatch) so the test picks who runs what.
    const replicas = [
      new WorkflowEngine({ store, runDispatcher: noDispatch, instanceId: 'a' }),
      new WorkflowEngine({ store, runDispatcher: noDispatch, instanceId: 'b' }),
    ];
    let inBody = 0;
    let maxInBody = 0;
    for (const engine of replicas) {
      engine.register(
        'job',
        '1',
        async (ctx, input) => {
          await ctx.localStep('enter', async () => {
            inBody += 1;
            maxInBody = Math.max(maxInBody, inBody);
          });
          await ctx.waitForSignal(`release:${input as string}`);
          await ctx.localStep('leave', async () => {
            inBody -= 1;
          });
        },
        { singleton: { key: () => 'k' } },
      );
    }
    const [a, b] = replicas as [WorkflowEngine, WorkflowEngine];
    await a.start('job', 'older', 'older', {});
    await settle(5);
    await a.start('job', 'younger', 'younger', {});
    // Replica B picks up the YOUNGER run first; the older one is still `pending` (not yet executing).
    await b.runOne('younger');
    // Then replica A picks up the older one.
    await a.runOne('older');
    // Exactly one of them is executing its body — never both.
    expect(maxInBody).toBe(1);
    const admitted = [await store.getRun('older'), await store.getRun('younger')].filter((r) =>
      r?.tags?.includes(SINGLETON_ADMITTED_TAG),
    );
    expect(admitted).toHaveLength(1);
    await a.drain();
    await b.drain();
  });

  it('a second engine preserves a sleeping holder across recovery and later starts', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const first = new WorkflowEngine({ store, clock: () => now, instanceId: 'first' });
    const second = new WorkflowEngine({ store, clock: () => now, instanceId: 'second' });
    const entered: string[] = [];
    for (const engine of [first, second]) {
      engine.register(
        'job',
        '1',
        async (ctx, input) => {
          await ctx.localStep('enter', async () => void entered.push(input as string));
          await ctx.sleep(10_000);
        },
        { singleton: { key: () => 'k' } },
      );
    }
    await startRun(first, 'job', 'holder', 'z-holder');
    await first.drain();
    await second.recoverIncomplete();
    // A later start whose id sorts first, on the OTHER engine: the sleeping holder keeps the slot.
    await startRun(second, 'job', 'waiter', 'a-waiter');
    expect(entered).toEqual(['holder']);
    now += 11_000;
    await second.resumeDueTimers(now);
    await until(() => entered.length === 2);
    expect(entered).toEqual(['holder', 'waiter']);
    // The settled holder released its slot.
    expect((await store.getRun('z-holder'))?.status).toBe('completed');
    expect((await store.getRun('z-holder'))?.tags).not.toContain(SINGLETON_ADMITTED_TAG);
    await second.drain();
  });

  it.each(['local', 'remote'] as const)(
    'a cancel that lands while a %s run waits for admission is never resurrected',
    async (placement) => {
      const store = new InMemoryStateStore();
      const engine = new WorkflowEngine({ store, runDispatcher: noDispatch });
      const executed = vi.fn(async () => 'done');
      if (placement === 'local') {
        engine.register('job', '1', executed, { singleton: { key: () => 'k' } });
      } else {
        engine.registerRemote('job', '1', {
          group: 'worker',
          executor: {
            advance: async (run): Promise<WorkflowDecision> => {
              await executed();
              return { taskId: 't', runId: run.id, status: 'completed', commands: [] };
            },
          },
          singleton: { key: () => 'k' },
        });
      }
      // A holder that is not this run, so the candidate is DENIED.
      await store.createRun({
        id: 'holder',
        workflow: 'job',
        workflowVersion: '1',
        status: 'suspended',
        input: {},
        tags: ['singleton:k', SINGLETON_ADMITTED_TAG],
        createdAt: new Date(1),
        updatedAt: new Date(1),
      });
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admit = store.tryAdmitSingleton.bind(store);
      vi.spyOn(store, 'tryAdmitSingleton').mockImplementation(async (...args) => {
        entered();
        await proceed;
        return admit(...args);
      });
      await engine.start('job', {}, 'run');
      const turn = engine.runOne('run');
      await waiting;
      await engine.cancel('run');
      release();
      await turn;
      // The denial must not overwrite the cancel with `suspended` (which would re-drive the run).
      expect((await store.getRun('run'))?.status).toBe('cancelled');
      expect(executed).not.toHaveBeenCalled();
      await engine.drain();
    },
  );

  it('fresh runs can neither supply nor inherit the admission marker', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const entered: string[] = [];
    engine.register(
      'job',
      '1',
      async (ctx) => {
        await ctx.localStep('enter', async () => void entered.push(ctx.runId));
        await ctx.waitForSignal(`release:${ctx.runId}`);
      },
      { singleton: { key: () => 'k' } },
    );
    await startRun(engine, 'job', {}, 'holder');
    await startRun(engine, 'job', {}, 'forged', { tags: [SINGLETON_ADMITTED_TAG, 'user-tag'] });
    // retryWithInput copies the holder's tags — the marker must not come along.
    const retry = await engine.retryWithInput('holder', {});
    if (!retry) throw new Error('holder disappeared');
    await engine.waitForRun(retry.runId);
    expect(entered).toEqual(['holder']);
    expect((await store.getRun('forged'))?.tags).toContain('user-tag');
    expect((await store.getRun('forged'))?.tags).not.toContain(SINGLETON_ADMITTED_TAG);
    expect((await store.getRun(retry.runId))?.tags).not.toContain(SINGLETON_ADMITTED_TAG);
    await engine.drain();
  });

  it('a store without tryAdmitSingleton still admits by scan and warns exactly once per engine', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new InMemoryStateStore();
      Object.defineProperty(store, 'tryAdmitSingleton', { value: undefined });
      let now = 1000;
      const engine = new WorkflowEngine({ store, clock: () => now });
      const entered: string[] = [];
      engine.register(
        'job',
        '1',
        async (ctx) => {
          await ctx.localStep('enter', async () => void entered.push(ctx.runId));
          await ctx.waitForSignal(`release:${ctx.runId}`);
        },
        { singleton: { key: () => 'k' } },
      );
      // No throw: the start creates the run, and scan admission serializes the key as before.
      expect((await startRun(engine, 'job', {}, 'first')).status).toBe('suspended');
      await settle(5);
      expect((await startRun(engine, 'job', {}, 'second')).status).toBe('suspended');
      expect(entered).toEqual(['first']);
      // Scan semantics: no durable slot is recorded.
      expect((await store.getRun('first'))?.tags).not.toContain(SINGLETON_ADMITTED_TAG);
      // The denied run was parked on its retry timer and re-checks there.
      expect((await store.getRun('second'))?.wakeAt).toBeGreaterThan(now);
      await engine.signal('release:first', null);
      await until(() => entered.length === 2);
      expect(entered).toEqual(['first', 'second']);

      const notAtomic = warn.mock.calls.filter((c) => String(c[0]).includes('tryAdmitSingleton'));
      expect(notAtomic).toHaveLength(1);
      expect(String(notAtomic[0]?.[0])).toContain('NOT atomic');
      now += 1;
      await engine.drain();
    } finally {
      warn.mockRestore();
    }
  });

  it('maxQueueDepth counts a blocked holder', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'job',
      '1',
      async (ctx) => {
        await ctx.waitForSignal('release');
      },
      { singleton: { key: () => 'k', maxQueueDepth: 0 } },
    );
    await startRun(engine, 'job', {}, 'holder');
    await store.updateRun('holder', { status: 'blocked' });
    await expect(engine.start('job', {}, 'waiter')).rejects.toBeInstanceOf(SingletonQueueFullError);
    expect(await store.getRun('waiter')).toBeNull();
    await engine.drain();
  });

  it('notify-on-release wakes a gated waiter, not a sleeping holder', async () => {
    let now = 1000;
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register(
      'job',
      '1',
      async (ctx) => {
        await ctx.sleep(60_000);
      },
      { singleton: { key: () => 'k', limit: 2 } },
    );
    await startRun(engine, 'job', {}, 'sleeper');
    await startRun(engine, 'job', {}, 'done-soon');
    await settle(5);
    await startRun(engine, 'job', {}, 'waiter');
    const sleeperWake = (await store.getRun('sleeper'))?.wakeAt;
    await engine.cancel('done-soon');
    await settle(10);
    // The sleeping holder's timer is untouched; the gated waiter was made due.
    expect((await store.getRun('sleeper'))?.wakeAt).toBe(sleeperWake);
    expect((await store.getRun('waiter'))?.tags).toContain(SINGLETON_ADMITTED_TAG);
    now += 1;
    await engine.drain();
  });

  it('a terminal settle releases the slot in the store', async () => {
    const store = new InMemoryStateStore();
    const run: WorkflowRun = {
      id: 'r',
      workflow: 'job',
      workflowVersion: '1',
      status: 'running',
      input: {},
      tags: ['singleton:k'],
      createdAt: new Date(1),
      updatedAt: new Date(1),
    };
    await store.createRun(run);
    expect(await store.tryAdmitSingleton('r', 'singleton:k', 'job', 1)).toBe(true);
    expect((await store.getRun('r'))?.tags).toEqual(['singleton:k', SINGLETON_ADMITTED_TAG]);
    await store.updateRun('r', { status: 'suspended' });
    expect((await store.getRun('r'))?.tags).toContain(SINGLETON_ADMITTED_TAG);
    expect(await store.updateRunIf('r', ['suspended'], { status: 'completed' })).toBe(true);
    expect((await store.getRun('r'))?.tags).toEqual(['singleton:k']);
  });
});

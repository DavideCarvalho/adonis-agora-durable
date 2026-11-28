import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { TransportPool } from '../../src/transport-pool.js';

/** A `@Step` reference, as the decorator stamps it. */
const fanStep = (() => {}) as unknown as StepRef<unknown, unknown>;
(fanStep as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = 'ext.fan';

class Recording implements Transport {
  readonly sent: RemoteTask[] = [];
  readonly calls: string[] = [];
  onResultHandler: ((r: StepResult) => Promise<void>) | undefined;
  async dispatch(task: RemoteTask): Promise<void> {
    this.sent.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.calls.push('onResult');
    this.onResultHandler = handler;
  }
  onHeartbeat(): void {
    this.calls.push('onHeartbeat');
  }
  useNamespace(namespace: string): void {
    this.calls.push(`useNamespace:${namespace}`);
  }
  consumeRepliesFor(instanceId: string): boolean {
    this.calls.push(`consumeRepliesFor:${instanceId}`);
    return true;
  }
  startConsumers(): void {
    this.calls.push('startConsumers');
  }
}

const task = (runId: string): Omit<RemoteTask, 'transport'> =>
  ({ runId, seq: 0, stepId: `${runId}:0`, name: 'ping', group: 'ping', input: {} }) as Omit<
    RemoteTask,
    'transport'
  >;

describe('TransportPool on demand', () => {
  it('builds a pinned id on first use and replays what it applied to the members', async () => {
    const a = new Recording();
    const b = new Recording();
    const build = vi.fn(async () => b);
    const pool = new TransportPool([{ id: 'a', transport: a }], { ids: ['b'], build });
    pool.useNamespace('tenant-1');
    pool.bind(
      async () => {},
      async () => {},
    );
    pool.routeReplies('inst-1');
    pool.startConsumers();

    await pool.dispatch({ ...task('r1'), replyTo: 'inst-1' }, 'b');
    expect(build).toHaveBeenCalledTimes(1);
    expect(b.calls).toEqual([
      'useNamespace:tenant-1',
      'onResult',
      'onHeartbeat',
      'consumeRepliesFor:inst-1',
      'startConsumers',
    ]);
    expect(b.sent.map((t) => [t.transport, t.replyTo])).toEqual([['b', 'inst-1']]);
    // An unpinned dispatch still goes to the first member; the built one is last in failover order.
    await pool.dispatch(task('r2'));
    expect(a.sent.map((t) => t.runId)).toEqual(['r2']);
    expect(pool.onDemandBuilt).toEqual(['b']);
    expect(pool.onDemandUnbuilt).toEqual([]);
  });

  it('shares one build between concurrent first uses, and forgets a failed one', async () => {
    const b = new Recording();
    let attempt = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const build = vi.fn(async () => {
      attempt += 1;
      await gate;
      if (attempt === 1) throw new Error('refused');
      return b;
    });
    const pool = new TransportPool([{ id: 'a', transport: new Recording() }], {
      ids: ['b'],
      build,
    });
    const first = pool.dispatch(task('r1'), 'b');
    const second = pool.dispatchMany([task('r2')], 'b');
    release();
    await expect(first).rejects.toThrow('refused');
    await expect(second).rejects.toThrow('refused');
    expect(build).toHaveBeenCalledTimes(1);

    await pool.dispatch(task('r3'), 'b');
    expect(build).toHaveBeenCalledTimes(2);
    expect(b.sent.map((t) => t.runId)).toEqual(['r3']);
  });

  it('an id it cannot build fails naming the members and the buildable ids', async () => {
    const pool = new TransportPool([{ id: 'a', transport: new Recording() }], {
      ids: ['b'],
      build: async () => new Recording(),
      hint: 'Define it somewhere.',
    });
    await expect(pool.dispatch(task('r1'), 'nope')).rejects.toThrow(
      'transport "nope" is not registered on this engine (registered: "a"; built on demand: "b"). Define it somewhere.',
    );
    const plain = new TransportPool([{ id: 'a', transport: new Recording() }]);
    await expect(plain.dispatch(task('r1'), 'nope')).rejects.toThrow(
      /transport "nope" is not registered on this engine \(registered: "a"\)/,
    );
  });
});

describe('WorkflowEngine onDemandTransports', () => {
  it('records the pin, and a restarted engine builds what pending steps name', async () => {
    const store = new InMemoryStateStore();
    const before = new Recording();
    const engine = new WorkflowEngine({
      store,
      transports: [{ id: 'main', transport: new Recording() }],
      onDemandTransports: { ids: ['side'], build: async () => before },
    });
    engine.register('wf', '1', async (ctx) => {
      const [x, y] = (await ctx.all(fanStep, [{}, {}], { transport: 'side' })) as unknown[];
      return ctx.step('ext.ping', { x, y }, { transport: 'side' });
    });
    expect((await startRun(engine, 'wf', {}, 'r1')).status).toBe('suspended');
    const pending = (await store.listCheckpoints('r1')).filter((cp) => cp.status === 'pending');
    expect(pending.map((cp) => cp.transport)).toEqual(['side', 'side']);

    // The restart: nothing pins `side`, yet `buildPendingTransports` builds it and its results land.
    const after = new Recording();
    const build = vi.fn(async () => after);
    const restarted = new WorkflowEngine({
      store,
      transports: [{ id: 'main', transport: new Recording() }],
      onDemandTransports: { ids: ['side', 'other'], build },
    });
    restarted.register('wf', '1', async (ctx) => {
      const [x, y] = (await ctx.all(fanStep, [{}, {}], { transport: 'side' })) as unknown[];
      return ctx.step('ext.ping', { x, y }, { transport: 'side' });
    });
    expect(await restarted.buildPendingTransports()).toEqual({
      built: ['side'],
      failed: [],
      supported: true,
    });
    expect(build).toHaveBeenCalledWith('side');
    expect(build).toHaveBeenCalledTimes(1);
    for (const t of before.sent) {
      await after.onResultHandler?.({
        runId: t.runId,
        seq: t.seq,
        stepId: t.stepId,
        status: 'completed',
        output: t.seq,
      });
    }
    await expect.poll(async () => (await restarted.getRun('r1'))?.status).toBe('suspended');
    // The last step went out on the built transport too.
    await expect.poll(() => after.sent.map((t) => t.name)).toEqual(['ext.ping']);
  });

  it('a store that cannot tell reports it, and a build failure is reported, not thrown', async () => {
    const store = new InMemoryStateStore();
    const noList = Object.assign(Object.create(store), { listPendingTransports: undefined });
    const engine = new WorkflowEngine({
      store: noList,
      transports: [{ id: 'main', transport: new Recording() }],
      onDemandTransports: { ids: ['side'], build: async () => new Recording() },
    });
    expect(await engine.buildPendingTransports()).toEqual({
      built: [],
      failed: [],
      supported: false,
    });

    vi.spyOn(store, 'listPendingTransports').mockResolvedValue(['side']);
    const failing = new WorkflowEngine({
      store,
      transports: [{ id: 'main', transport: new Recording() }],
      onDemandTransports: {
        ids: ['side'],
        build: async () => {
          throw new Error('down');
        },
      },
    });
    const result = await failing.buildPendingTransports();
    expect(result.built).toEqual([]);
    expect(result.failed.map((f) => f.id)).toEqual(['side']);
  });
});

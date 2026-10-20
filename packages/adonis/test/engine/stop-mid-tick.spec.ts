import { describe, expect, it } from 'vitest';
import { runWorkerLoop } from '../../src/commands/worker.js';
import {
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
  type WorkflowRun,
} from '../../src/index.js';

function backlog(n: number): WorkflowRun[] {
  return Array.from(
    { length: n },
    (_, i) => ({ id: `run-${i}`, status: 'pending' }) as WorkflowRun,
  );
}

describe('stop requested mid-tick', () => {
  it('locks no further runs once a stop is requested, and the loop returns promptly', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const total = 100;
    store.listPendingRuns = async () => backlog(total);
    let locks = 0;
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    store.tryLockRun = async () => {
      locks += 1;
      if (locks === 3) stop(); // stop arrives while the tick is still working through the backlog
      await new Promise((r) => setTimeout(r, 20)); // each lock is slow, like a loaded store
      return false;
    };
    const started = Date.now();
    await runWorkerLoop(engine, {
      intervalMs: 1000,
      stopSignal,
      logger: { info: () => undefined, error: () => undefined },
      drainTimeoutMs: 100,
    });
    // 8 workers may each already be inside tryLockRun; nothing past those is started.
    expect(locks).toBeLessThanOrEqual(8 + 1);
    expect(Date.now() - started).toBeLessThan(total * 20 * 0.5);
  });

  it('starts no scheduled run after a stop is requested mid-tick', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    engine.register('tick-wf', '1', async () => 'done');
    store.listPendingRuns = async () => backlog(2);
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    store.tryLockRun = async () => {
      stop();
      await new Promise((r) => setTimeout(r, 10));
      return false;
    };
    const started: string[] = [];
    const realStart = engine.start.bind(engine);
    engine.start = (async (...args: Parameters<typeof realStart>) => {
      started.push(String(args[2]));
      return realStart(...args);
    }) as typeof engine.start;
    await runWorkerLoop(engine, {
      intervalMs: 1000,
      stopSignal,
      logger: { info: () => undefined, error: () => undefined },
      drainTimeoutMs: 100,
      schedules: [{ key: 'k', workflow: 'tick-wf', input: null, everyMs: 1000 }],
    });
    expect(started).toEqual([]);
  });

  it('beginDrain makes runOne refuse broker-delivered runs and drain() implies it', async () => {
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    expect(engine.isDraining()).toBe(false);
    engine.beginDrain();
    expect(engine.isDraining()).toBe(true);
    expect(await engine.runOne('any')).toBeNull();
    const other = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    await other.drain(10);
    expect(other.isDraining()).toBe(true);
  });
});

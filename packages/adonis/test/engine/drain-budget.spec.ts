import { describe, expect, it } from 'vitest';
import { runWorkerLoop } from '../../src/commands/worker.js';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const quiet = { info: () => undefined, error: () => undefined };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An engine with one run whose body never finishes, so `drain()` always waits out its budget. */
async function wedged(): Promise<{ engine: WorkflowEngine; store: InMemoryStateStore }> {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('wf', '1', () => new Promise<void>(() => {}));
  await engine.start('wf', {}, 'r1');
  await sleep(20); // let the run register as in flight
  return { engine, store };
}

describe('drain budget: the whole shutdown stays within one timeout', () => {
  it('drain() is charged only for wait reported through beginDrain, not for time that merely passes', async () => {
    const { engine } = await wedged();
    engine.beginDrain();
    await sleep(150); // other shutdown hooks: not charged
    let started = Date.now();
    await engine.drain(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);

    engine.beginDrain(150); // 150 ms actually spent waiting elsewhere: deducted
    started = Date.now();
    await engine.drain(200);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('beginDrain ignores NaN, Infinity and negative reports', async () => {
    const { engine } = await wedged();
    engine.beginDrain(Number.NaN);
    engine.beginDrain(Number.POSITIVE_INFINITY);
    engine.beginDrain(-500);
    engine.beginDrain('x' as unknown as number);
    const started = Date.now();
    await engine.drain(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150); // the full budget, not ~0 ms
  });

  it('a drain already waiting is shortened when wait is reported late', async () => {
    const { engine } = await wedged();
    const started = Date.now();
    const draining = engine.drain(400);
    await sleep(50);
    engine.beginDrain(300);
    await draining;
    expect(Date.now() - started).toBeLessThan(250); // deadline ≈ start + 400 - 300
  });

  it('the worker loop deducts the wait for its in-flight tick from the drain', async () => {
    const { engine, store } = await wedged();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    // The tick's pending sweep takes 300 ms; the stop arrives as soon as it starts.
    store.listPendingRuns = async () => {
      stop();
      await sleep(300);
      return [];
    };
    const started = Date.now();
    await runWorkerLoop(engine, {
      intervalMs: 1000,
      stopSignal,
      logger: quiet,
      drainTimeoutMs: 500,
    });
    const took = Date.now() - started;
    // Tick wait (~300) + drain remainder (~200) = one 500 ms budget, not 300 + 500.
    expect(took).toBeGreaterThanOrEqual(400);
    expect(took).toBeLessThan(700);
  });

  it('a tick that outlives the whole budget is not waited for', async () => {
    const { engine, store } = await wedged();
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    store.listPendingRuns = async () => {
      stop();
      await sleep(2_000);
      return [];
    };
    const errors: string[] = [];
    const started = Date.now();
    await runWorkerLoop(engine, {
      intervalMs: 1000,
      stopSignal,
      logger: { info: () => undefined, error: (m: string) => void errors.push(m) },
      drainTimeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(600);
    expect(errors.join(' ')).toContain('still running');
  });
});

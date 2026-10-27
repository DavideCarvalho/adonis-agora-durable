import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  Heartbeat,
  RemoteTask,
  StateStore,
  StepResult,
  Transport,
} from '../../src/interfaces.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * What settling a wide step fan's results costs, counted rather than timed: store calls per result,
 * batch sizes, barrier reads and parent turns, with several engine instances sharing one store and
 * one point-to-point results queue. A results consumer holds at most `inFlight` results at a time,
 * as a broker consumer with that concurrency does, and every store call answers a turn of the event
 * loop later, as a database does.
 */

const STEP = 'Lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = STEP;

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

/** The results path's store calls: what settling a result can cost. */
const RESULT_PATH = [
  'getCheckpoint',
  'getCheckpoints',
  'getRun',
  'saveCheckpointsIfPending',
  'saveCheckpointIfPending',
  'settleCheckpointsIfPending',
  'countCheckpoints',
  'hasCheckpoints',
  'listCheckpoints',
];

class Broker {
  readonly results: StepResult[] = [];
  readonly consumers: Consumer[] = [];
  /** Results that fail, by seq; every other step completes with `i * 10`. */
  failing = new Set<number>();
  run(task: RemoteTask): void {
    const i = (task.input as { i: number }).i;
    const result: StepResult = this.failing.has(i)
      ? {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'failed',
          error: { message: `bad line ${i}`, retryable: false },
        }
      : {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'completed',
          output: i * 10,
        };
    setImmediate(() => {
      this.results.push(result);
      this.pump();
    });
  }
  pump(): void {
    for (const c of this.consumers) c.pull();
  }
}

class Consumer implements Transport {
  private handler?: (r: StepResult) => Promise<void>;
  private active = 0;
  /** `dispatch` and `dispatchMany` calls, across every consumer. */
  static calls = { one: 0, many: 0 };
  constructor(
    private readonly broker: Broker,
    private readonly inFlight: number,
  ) {
    broker.consumers.push(this);
  }
  async dispatch(task: RemoteTask): Promise<void> {
    Consumer.calls.one += 1;
    this.broker.run(task);
  }
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    Consumer.calls.many += 1;
    for (const task of tasks) this.broker.run(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  pull(): void {
    while (this.handler && this.active < this.inFlight && this.broker.results.length > 0) {
      const result = this.broker.results.shift() as StepResult;
      this.active += 1;
      void this.handler(result)
        .catch(() => this.broker.results.push(result))
        .finally(() => {
          this.active -= 1;
          setImmediate(() => this.broker.pump());
        });
    }
  }
}

interface Counts {
  calls: Map<string, number>;
  batches: number[];
}

function counted(inner: StateStore, counts: Counts): StateStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const name = String(prop);
        counts.calls.set(name, (counts.calls.get(name) ?? 0) + 1);
        if (name === 'saveCheckpointsIfPending') counts.batches.push((args[0] as unknown[]).length);
        if (name === 'saveCheckpointIfPending') counts.batches.push(1);
        if (name === 'settleCheckpointsIfPending') {
          counts.batches.push((args[0] as unknown[]).length);
        }
        // A round-trip: the call answers on a later turn of the event loop, as a database does.
        return new Promise((r) => setImmediate(r)).then(() => value.apply(target, args));
      };
    },
  });
}

async function until(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met');
}

async function fan(opts: {
  size: number;
  instances: number;
  inFlight: number;
  concurrency?: number;
  settled?: boolean;
  failing?: number[];
  /** Leave out {@link StateStore.getCheckpoints}, as a store without it does. */
  noBatchedRead?: boolean;
  /** Leave out `saveCheckpoints` and `dispatchMany`, as a store and transport without them do. */
  noBulkSend?: boolean;
}) {
  const inner = new InMemoryStateStore();
  if (opts.noBatchedRead) Object.defineProperty(inner, 'getCheckpoints', { value: undefined });
  if (opts.noBulkSend) Object.defineProperty(inner, 'saveCheckpoints', { value: undefined });
  Consumer.calls = { one: 0, many: 0 };
  const broker = new Broker();
  broker.failing = new Set(opts.failing ?? []);
  const counts: Counts = { calls: new Map(), batches: [] };
  let turns = 0;
  const settledSeqs: number[] = [];
  const engines = Array.from({ length: opts.instances }, () => {
    const engine = new WorkflowEngine({
      store: counted(inner, counts),
      transport: (() => {
        const consumer = new Consumer(broker, opts.inFlight);
        if (opts.noBulkSend) Object.defineProperty(consumer, 'dispatchMany', { value: undefined });
        return consumer;
      })(),
      reconcileMs: 0,
    });
    engine.register('fan', '1', async (ctx) => {
      turns += 1;
      const inputs = lines(opts.size);
      const options = opts.concurrency === undefined ? {} : { concurrency: opts.concurrency };
      if (opts.settled) {
        const all = await ctx.allSettled(processLine, inputs, options);
        return all.map((s) => (s.status === 'fulfilled' ? s.value : 'failed'));
      }
      return ctx.all(processLine, inputs, options);
    });
    engine.subscribe((e) => {
      if (e.type === 'step.completed' || e.type === 'step.failed') settledSeqs.push(e.seq ?? -1);
    });
    return engine;
  });
  await (engines[0] as WorkflowEngine).start('fan', {}, 'p');
  await until(async () => {
    const status = (await inner.getRun('p'))?.status;
    return status === 'completed' || status === 'failed';
  });
  const resultCalls = RESULT_PATH.reduce((sum, name) => sum + (counts.calls.get(name) ?? 0), 0);
  return {
    run: await inner.getRun('p'),
    turns,
    settledSeqs,
    barrierReads:
      (counts.calls.get('countCheckpoints') ?? 0) + (counts.calls.get('hasCheckpoints') ?? 0),
    callsPerResult: resultCalls / opts.size,
    sends: {
      saveCheckpoint: counts.calls.get('saveCheckpoint') ?? 0,
      saveCheckpoints: counts.calls.get('saveCheckpoints') ?? 0,
      dispatch: Consumer.calls.one,
      dispatchMany: Consumer.calls.many,
    },
    meanBatch: counts.batches.reduce((a, b) => a + b, 0) / Math.max(1, counts.batches.length),
  };
}

const outputs = (n: number) => lines(n).map(({ i }) => i * 10);

describe('wide step fan result throughput', () => {
  it('ctx.all over 20k steps on 4 instances: a few store calls per batch, O(1) barrier reads and turns', async () => {
    const r = await fan({ size: 20_000, instances: 4, inFlight: 512 });
    expect(r.run?.status).toBe('completed');
    expect(r.run?.output).toEqual(outputs(20_000));
    expect(r.settledSeqs).toHaveLength(20_000);
    expect(new Set(r.settledSeqs).size).toBe(20_000);
    // The dispatching turn, then one once the fan settled.
    expect(r.turns).toBe(2);
    // A read, a run check and a write per batch of a hundred-odd results.
    expect(r.callsPerResult).toBeLessThanOrEqual(0.1);
    expect(r.meanBatch).toBeGreaterThan(100);
    // Read when a queue drains, not per batch: bounded by the instances, not the fan.
    expect(r.barrierReads).toBeLessThanOrEqual(3 * 4);
  }, 120_000);

  it('the dispatching turn writes and dispatches a fan in rounds of 2,000, one call each', async () => {
    const r = await fan({ size: 20_000, instances: 2, inFlight: 512 });
    expect(r.run?.status).toBe('completed');
    expect(r.sends).toEqual({
      saveCheckpoint: 0,
      saveCheckpoints: 10,
      dispatch: 0,
      dispatchMany: 10,
    });
  }, 120_000);

  it('a store and transport without bulk sends write and dispatch the fan one step at a time', async () => {
    const r = await fan({ size: 2_000, instances: 2, inFlight: 512, noBulkSend: true });
    expect(r.run?.status).toBe('completed');
    expect(r.run?.output).toEqual(outputs(2_000));
    expect(r.sends).toEqual({
      saveCheckpoint: 2_000,
      saveCheckpoints: 0,
      dispatch: 2_000,
      dispatchMany: 0,
    });
  }, 120_000);

  it('waves are written and dispatched one call each per wave', async () => {
    const r = await fan({ size: 8_000, instances: 2, inFlight: 512, concurrency: 2_000 });
    expect(r.run?.status).toBe('completed');
    expect(r.sends).toEqual({
      saveCheckpoint: 0,
      saveCheckpoints: 4,
      dispatch: 0,
      dispatchMany: 4,
    });
  }, 120_000);

  it('a store without batched reads costs about one read per result', async () => {
    const r = await fan({ size: 10_000, instances: 4, inFlight: 512, noBatchedRead: true });
    expect(r.run?.status).toBe('completed');
    expect(r.run?.output).toEqual(outputs(10_000));
    expect(r.turns).toBe(2);
    expect(r.callsPerResult).toBeLessThanOrEqual(1.1);
    expect(r.barrierReads).toBeLessThanOrEqual(3 * 4);
  }, 120_000);

  it('a consumer holding few results at a time still reads the barrier O(1) times, not once per batch', async () => {
    const r = await fan({ size: 4_000, instances: 6, inFlight: 4 });
    expect(r.run?.status).toBe('completed');
    expect(r.run?.output).toEqual(outputs(4_000));
    expect(r.turns).toBe(2);
    expect(r.barrierReads).toBeLessThanOrEqual(3 * 6);
  }, 120_000);

  it('ctx.allSettled over 10k steps settles at the same cost', async () => {
    const r = await fan({ size: 10_000, instances: 3, inFlight: 512, settled: true });
    expect(r.run?.status).toBe('completed');
    expect(r.run?.output).toEqual(outputs(10_000));
    expect(r.turns).toBe(2);
    expect(r.callsPerResult).toBeLessThanOrEqual(0.1);
    expect(r.barrierReads).toBeLessThanOrEqual(3 * 3);
  }, 120_000);

  it('with concurrency, each wave costs one turn and O(1) barrier reads', async () => {
    for (const settled of [false, true]) {
      const r = await fan({
        size: 8_000,
        instances: 3,
        inFlight: 512,
        concurrency: 2_000,
        settled,
      });
      expect(r.run?.status).toBe('completed');
      expect(r.run?.output).toEqual(outputs(8_000));
      // One dispatching turn, then one per settled wave.
      expect(r.turns).toBe(5);
      expect(r.callsPerResult).toBeLessThanOrEqual(0.1);
      expect(r.barrierReads).toBeLessThanOrEqual(4 * 3 * 3);
    }
  }, 120_000);

  it('ctx.allSettled with failures still settles every step and reports each failure', async () => {
    const failing = [3, 1_500, 2_999];
    const r = await fan({ size: 3_000, instances: 3, inFlight: 512, settled: true, failing });
    expect(r.run?.status).toBe('completed');
    expect(r.run?.output).toEqual(
      outputs(3_000).map((v, i) => (failing.includes(i) ? 'failed' : v)),
    );
    expect(new Set(r.settledSeqs).size).toBe(3_000);
  }, 120_000);
});

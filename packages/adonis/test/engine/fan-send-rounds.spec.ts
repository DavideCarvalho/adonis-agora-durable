import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type {
  RemoteTask,
  StateStore,
  StepCheckpoint,
  StepResult,
  Transport,
} from '../../src/interfaces.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * A wide step fan is written and dispatched in rounds: workers start on the first steps while the
 * rest of the fan's checkpoints are still being written, and no result can wake the run before the
 * whole fan is written.
 */

const LINE = 'Lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as unknown as { [DURABLE_STEP_NAME]: string })[DURABLE_STEP_NAME] = LINE;

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

async function until(check: () => boolean | Promise<boolean>, max = 5000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

const ok = (t: RemoteTask): StepResult => ({
  runId: t.runId,
  seq: t.seq,
  stepId: t.stepId,
  status: 'completed',
  output: (t.input as { i: number }).i * 10,
});

/** Logs each checkpoint write and dispatch, in order. */
class LoggingTransport implements Transport {
  readonly dispatched: RemoteTask[] = [];
  handler?: (r: StepResult) => Promise<void>;
  constructor(
    private readonly log: string[],
    private readonly onDispatch?: (tasks: RemoteTask[]) => Promise<void>,
  ) {}
  async dispatch(task: RemoteTask): Promise<void> {
    await this.dispatchMany([task]);
  }
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    this.log.push(`dispatch:${tasks.length}`);
    this.dispatched.push(...tasks);
    await this.onDispatch?.(tasks);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.handler = handler;
  }
  onHeartbeat(): void {}
}

function loggingStore(log: string[]): StateStore {
  const inner = new InMemoryStateStore();
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'saveCheckpoints') {
        return async (cps: StepCheckpoint[]) => {
          if (cps.some((cp) => cp.status === 'pending')) log.push(`save:${cps.length}`);
          return (value as (cps: StepCheckpoint[]) => Promise<void>).call(target, cps);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('a wide step fan is sent in rounds', () => {
  it('dispatches its first steps before the last of its checkpoints is written', async () => {
    const log: string[] = [];
    const transport = new LoggingTransport(log);
    const engine = new WorkflowEngine({ store: loggingStore(log), transport, reconcileMs: 0 });
    engine.register('fan', '1', (ctx, input) =>
      ctx.all(processLine, lines((input as { n: number }).n)),
    );

    await engine.start('fan', { n: 10_000 }, 'r');
    await until(() => transport.dispatched.length === 10_000);

    const lastSave = log.map((e) => e.startsWith('save:')).lastIndexOf(true);
    const firstDispatch = log.findIndex((e) => e.startsWith('dispatch:'));
    expect(firstDispatch).toBeGreaterThanOrEqual(0);
    expect(firstDispatch).toBeLessThan(lastSave);
    expect(log.filter((e) => e.startsWith('save:'))).toEqual(Array(5).fill('save:2000'));
    expect(log.filter((e) => e.startsWith('dispatch:'))).toEqual(Array(5).fill('dispatch:2000'));
  });

  it('dispatches every step once, in seq order, with its own input', async () => {
    const log: string[] = [];
    const transport = new LoggingTransport(log);
    const engine = new WorkflowEngine({ store: loggingStore(log), transport, reconcileMs: 0 });
    engine.register('fan', '1', (ctx, input) =>
      ctx.all(processLine, lines((input as { n: number }).n)),
    );

    await engine.start('fan', { n: 4_500 }, 'r');
    await until(() => transport.dispatched.length === 4_500);

    const seqs = transport.dispatched.map((t) => t.seq);
    expect(new Set(seqs).size).toBe(4_500);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(transport.dispatched.map((t) => (t.input as { i: number }).i)).toEqual(
      lines(4_500).map((l) => l.i),
    );
    expect(log.filter((e) => e.startsWith('dispatch:'))).toEqual([
      'dispatch:2000',
      'dispatch:2000',
      'dispatch:500',
    ]);
  });

  it('completes the fan when its first rounds settle while later rounds are still being written', async () => {
    const log: string[] = [];
    const delivered: Promise<void>[] = [];
    // Each round's results are delivered as soon as the round is dispatched, so they settle while
    // the send turn is still writing the next rounds.
    const transport: LoggingTransport = new LoggingTransport(log, async (tasks) => {
      delivered.push(
        Promise.resolve().then(async () => {
          for (const t of tasks) await transport.handler?.(ok(t));
        }),
      );
    });
    const engine = new WorkflowEngine({ store: loggingStore(log), transport, reconcileMs: 0 });
    engine.register('fan', '1', (ctx, input) =>
      ctx.all(processLine, lines((input as { n: number }).n)),
    );

    const runId = 'r';
    await engine.start('fan', { n: 6_000 }, runId);
    await until(async () => (await engine.getRun(runId))?.status === 'completed');
    await Promise.all(delivered);

    const run = await engine.getRun(runId);
    expect(run?.output).toEqual(lines(6_000).map((l) => l.i * 10));
    expect(transport.dispatched).toHaveLength(6_000);
    expect(new Set(transport.dispatched.map((t) => t.seq)).size).toBe(6_000);
  });
});

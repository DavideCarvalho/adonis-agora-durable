import {
  InMemoryStateStore,
  InMemoryTransport,
  type RunResult,
  type StartOptions,
  WorkflowEngine,
  type WorkflowRef,
} from '../index.js';

/** A clock you control, for testing durable sleeps without real time. */
export class MutableClock {
  constructor(private current = 1_000) {}
  readonly now = (): number => this.current;
  set(ms: number): void {
    this.current = ms;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface TestEngine {
  engine: WorkflowEngine;
  store: InMemoryStateStore;
  transport: InMemoryTransport;
  clock: MutableClock;
  /** Advance the clock by `ms`, resume any durable sleeps now due, and publish owed lifecycle events. */
  tick(ms: number): Promise<RunResult[]>;
  /**
   * Enqueue a run and wait for it to settle (terminal or suspended). `engine.start` only enqueues
   * now (dispatch model), so use this when a test needs the outcome synchronously.
   */
  run(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
}

/**
 * A self-contained engine wired to in-memory store + transport and a controllable clock — run a
 * whole workflow in a unit test, with no Postgres, no Redis, and no real time.
 */
export function createTestEngine(): TestEngine {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const clock = new MutableClock();
  const engine = new WorkflowEngine({ store, transport, clock: clock.now });
  return {
    engine,
    store,
    transport,
    clock,
    async tick(ms: number): Promise<RunResult[]> {
      clock.advance(ms);
      const resumed = await engine.resumeDueTimers(clock.now());
      await engine.sweepLifecycleEvents(clock.now());
      return resumed;
    },
    async run(workflow, input, runId, opts): Promise<RunResult> {
      // `start` is overloaded per ref kind; a `WorkflowRef` union fits neither overload directly, so
      // resolve to the string overload (the engine accepts a class or name at runtime).
      await engine.start(workflow as string, input, runId, opts);
      return engine.waitForRun(runId);
    },
  };
}

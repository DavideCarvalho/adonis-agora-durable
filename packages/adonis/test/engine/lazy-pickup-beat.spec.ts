import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask } from '../../src/interfaces.js';
import { PICKUP_BEAT_GRACE_MS, runStepHandler } from '../../src/protocol.js';
import { DURABLE_STEP_NAME, type StepRef } from '../../src/step-name-symbol.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { EventEmitterTransport } from '../../src/transports/event-emitter.js';

/**
 * A fan step's pickup heartbeat only stamps `lastHeartbeatAt` and feeds the lease renewal: nothing
 * awaits it with a liveness timeout. Its worker sends it once the step has run for a second, and not
 * at all when the step settles sooner, so a wide fan does not publish one beat per step to every
 * engine. Every other step still beats the moment its worker picks it up.
 */

const STEP = 'lines.process';
const processLine = (() => {}) as unknown as StepRef<{ i: number }, number>;
(processLine as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = STEP;

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r',
  seq: 0,
  name: STEP,
  stepId: 'r:0',
  group: STEP,
  input: { i: 1 },
  attempt: 1,
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the pickup beat of a task marked lazyPickupBeat', () => {
  it('is not sent for a step that settles within the grace', async () => {
    const beats: Heartbeat[] = [];
    const result = await runStepHandler(
      task({ lazyPickupBeat: true }),
      async () => 'ok',
      (b) => {
        beats.push(b);
      },
    );
    expect(result.status).toBe('completed');
    await new Promise((r) => setTimeout(r, PICKUP_BEAT_GRACE_MS + 50));
    expect(beats).toEqual([]);
  });

  it('is sent once the step has run for the grace', async () => {
    vi.useFakeTimers();
    const beats: Heartbeat[] = [];
    let release!: () => void;
    const settled = runStepHandler(
      task({ lazyPickupBeat: true }),
      () =>
        new Promise((r) => {
          release = () => r('ok');
        }),
      (b) => {
        beats.push(b);
      },
    );
    await vi.advanceTimersByTimeAsync(PICKUP_BEAT_GRACE_MS - 1);
    expect(beats).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(beats).toEqual([expect.objectContaining({ runId: 'r', seq: 0, stepId: 'r:0' })]);
    release();
    await settled;
    await vi.advanceTimersByTimeAsync(PICKUP_BEAT_GRACE_MS * 2);
    expect(beats).toHaveLength(1);
  });

  it('is replaced by a beat the handler sends itself', async () => {
    vi.useFakeTimers();
    const beats: Heartbeat[] = [];
    let release!: () => void;
    const settled = runStepHandler(
      task({ lazyPickupBeat: true }),
      (_input, log) => {
        log.heartbeat({ done: 1 });
        return new Promise((r) => {
          release = () => r('ok');
        });
      },
      (b) => {
        beats.push(b);
      },
    );
    await vi.advanceTimersByTimeAsync(PICKUP_BEAT_GRACE_MS * 2);
    expect(beats.map((b) => b.progress)).toEqual([{ done: 1 }]);
    release();
    await settled;
  });
});

describe('a task without lazyPickupBeat', () => {
  it('beats at pickup, before its handler returns', async () => {
    const beats: Heartbeat[] = [];
    await runStepHandler(
      task(),
      async () => 'ok',
      (b) => {
        beats.push(b);
      },
    );
    expect(beats).toHaveLength(1);
  });
});

describe('the engine', () => {
  it('marks the steps of a fan lazy, and a fan of fast steps sends no heartbeat', async () => {
    const store = new InMemoryStateStore();
    const transport = new EventEmitterTransport();
    const dispatched: RemoteTask[] = [];
    const dispatch = transport.dispatch.bind(transport);
    transport.dispatch = async (t) => {
      dispatched.push(t);
      return dispatch(t);
    };
    const beats: Heartbeat[] = [];
    const heartbeat = transport.heartbeat.bind(transport);
    transport.heartbeat = async (b) => {
      beats.push(b);
      return heartbeat(b);
    };
    transport.handle(STEP, async (input) => (input as { i: number }).i);
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('fan', '1', async (ctx) =>
      ctx.all(
        processLine,
        Array.from({ length: 50 }, (_, i) => ({ i })),
      ),
    );

    await engine.start('fan', {}, 'p');
    expect((await engine.waitForRun('p', { terminal: true })).status).toBe('completed');
    expect(dispatched).toHaveLength(50);
    expect(dispatched.every((t) => t.lazyPickupBeat === true)).toBe(true);
    await new Promise((r) => setTimeout(r, PICKUP_BEAT_GRACE_MS + 50));
    expect(beats).toEqual([]);
  });

  it('does not mark a single step, which may be awaited with a liveness timeout', async () => {
    const store = new InMemoryStateStore();
    const transport = new EventEmitterTransport();
    const dispatched: RemoteTask[] = [];
    const dispatch = transport.dispatch.bind(transport);
    transport.dispatch = async (t) => {
      dispatched.push(t);
      return dispatch(t);
    };
    transport.handle(STEP, async () => 1);
    const engine = new WorkflowEngine({ store, transport, reconcileMs: 0 });
    engine.register('one', '1', async (ctx) => ctx.step(STEP, {}, { timeoutMs: 60_000 }));

    await engine.start('one', {}, 'p');
    expect((await engine.waitForRun('p', { terminal: true })).status).toBe('completed');
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.some((t) => t.lazyPickupBeat)).toBe(false);
  });
});

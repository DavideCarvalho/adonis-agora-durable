import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type {
  EngineEvent,
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowStepEvent,
} from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/**
 * Capability- & protocol-aware dispatch (design §7.5/§7.6): a run whose next dispatch has no live
 * capable+compatible worker must PARK `blocked` with a structured diagnostics event — never dispatch
 * into a queue nobody consumes (a silent hang). When a capable worker appears the run proceeds.
 */

/** Build a full worker {@link WorkerDescriptor} for a token — the shape the transport advertises. */
function worker(partial: Partial<WorkerDescriptor> & { instanceId: string }): WorkerDescriptor {
  return {
    runtime: 'node',
    sdk: { name: 'test', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [],
    steps: [],
    startedAt: 0,
    ...partial,
  };
}

/**
 * An in-process transport that ALSO advertises handshake descriptors per token — so the engine's
 * capability guard has a live fleet to consult. `descriptors` is mutable so a test can make a capable
 * worker "appear" mid-flight and prove recovery. Records every dispatch so a blocked run can assert it
 * never dispatched into the void.
 */
class CapabilityTransport implements Transport {
  descriptors: WorkerDescriptor[] = [];
  readonly dispatched: RemoteTask[] = [];
  private resultHandler?: (result: StepResult) => Promise<void>;
  private readonly handlers = new Map<string, (input: unknown) => unknown>();

  handle(name: string, fn: (input: unknown) => unknown): void {
    this.handlers.set(name, fn);
  }

  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
    const fn = this.handlers.get(task.name);
    const result: StepResult = fn
      ? {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'completed',
          output: fn(task.input),
        }
      : {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'completed',
          output: null,
        };
    setImmediate(() => void this.resultHandler?.(result));
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  onStepEvent(_handler: (event: WorkflowStepEvent) => Promise<void>): void {}

  async listWorkerDescriptors(
    _token: string,
    _opts?: { fresh?: boolean | undefined },
  ): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
}

/** Drive deferred results/resumes until the run reaches a resting state (terminal OR blocked). */
async function settle(store: InMemoryStateStore, runId: string, max = 100) {
  for (let i = 0; i < max; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'pending' && run.status !== 'suspended') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('WorkflowEngine — capability/protocol-aware dispatch', () => {
  it('parks the run BLOCKED + fires a capability.unavailable diagnostics event when no live worker has the capability', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    transport.handle('billing.charge', () => ({ ok: true }));
    // A live worker exists — but it does NOT advertise the required 'saga' capability.
    transport.descriptors = [worker({ instanceId: 'w1', capabilities: ['signals'] })];

    const engine = new WorkflowEngine({ store, transport });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('billing.charge', { amount: 1 }, { requires: ['saga'] });
      return 'done';
    });

    await engine.start('checkout', {}, 'run1');
    const run = await settle(store, 'run1');

    // 1) The run parked blocked (never dispatched into the void).
    expect(run.status).toBe('blocked');
    expect(run.error?.message).toContain('no compatible worker');
    expect(run.error?.message).toContain('saga');
    expect(transport.dispatched).toHaveLength(0);

    // 2) A structured diagnostics event fired, carrying the exact delta (design §7.6).
    const diag = events.find((e) => e.type === 'capability.unavailable');
    expect(diag).toBeDefined();
    expect(diag?.runId).toBe('run1');
    expect(diag?.diagnostics?.requires).toEqual(['saga']);
    expect(diag?.diagnostics?.missingCapabilities).toEqual(['saga']);
    expect(diag?.diagnostics?.liveWorkers).toBe(1);
    expect(diag?.diagnostics?.workers).toHaveLength(1);
    expect(diag?.diagnostics?.controlPlane.instanceId).toBeDefined();
  });

  it('re-reads the descriptors before parking: a capable worker missing from a reused read still gets the step', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    transport.handle('billing.charge', () => ({ charged: true }));
    // A reused (cached) read still shows the old fleet; a fresh one sees the capable worker.
    const fresh: boolean[] = [];
    transport.listWorkerDescriptors = async (_token, opts) => {
      fresh.push(opts?.fresh === true);
      return opts?.fresh
        ? [worker({ instanceId: 'w2', capabilities: ['saga'] })]
        : [worker({ instanceId: 'w1', capabilities: ['signals'] })];
    };
    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      const r = await ctx.step<{ charged: boolean }>(
        'billing.charge',
        { amount: 1 },
        { requires: ['saga'] },
      );
      return r.charged;
    });
    await engine.start('checkout', {}, 'run1');
    const run = await settle(store, 'run1');
    expect(run.status).toBe('completed');
    expect(transport.dispatched).toHaveLength(1);
    // The reused read first, then one fresh read before deciding to park.
    expect(fresh.slice(0, 2)).toEqual([false, true]);
  });

  it('dispatches normally when a live worker advertises the required capability', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    transport.handle('billing.charge', () => ({ charged: true }));
    transport.descriptors = [worker({ instanceId: 'w1', capabilities: ['saga', 'signals'] })];

    const engine = new WorkflowEngine({ store, transport });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    engine.register('checkout', '1', async (ctx) => {
      const r = await ctx.step<{ charged: boolean }>(
        'billing.charge',
        { amount: 1 },
        {
          requires: ['saga'],
        },
      );
      return r.charged;
    });

    await engine.start('checkout', {}, 'run1');
    const run = await settle(store, 'run1');

    expect(run.status).toBe('completed');
    expect(run.output).toBe(true);
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]?.name).toBe('billing.charge');
    // No diagnostics event — the fleet could run it.
    expect(events.some((e) => e.type === 'capability.unavailable')).toBe(false);
    expect(events.some((e) => e.type === 'protocol.incompatible')).toBe(false);
  });

  it('parks BLOCKED + fires protocol.incompatible when a capable worker exists but every one is on an incompatible protocol major', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    transport.handle('billing.charge', () => ({ ok: true }));
    // The worker HAS the capability, but speaks protocol major 2 — the control plane speaks v1.
    transport.descriptors = [
      worker({ instanceId: 'w1', capabilities: ['saga'], protocol: { version: 2, range: [2, 2] } }),
    ];

    const engine = new WorkflowEngine({ store, transport });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('billing.charge', { amount: 1 }, { requires: ['saga'] });
      return 'done';
    });

    await engine.start('checkout', {}, 'run1');
    const run = await settle(store, 'run1');

    expect(run.status).toBe('blocked');
    expect(run.error?.message).toContain('no protocol-compatible worker');
    expect(transport.dispatched).toHaveLength(0);

    const diag = events.find((e) => e.type === 'protocol.incompatible');
    expect(diag).toBeDefined();
    expect(diag?.diagnostics?.controlPlaneRange).toEqual([1, 1]);
    expect(diag?.diagnostics?.workerRanges).toEqual([[2, 2]]);
  });

  it('a blocked run PROCEEDS once a capable+compatible worker appears (recovery poll re-drives it)', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    transport.handle('billing.charge', () => ({ charged: true }));
    // Start with only an incapable worker → the run blocks.
    transport.descriptors = [worker({ instanceId: 'w1', capabilities: ['signals'] })];

    const engine = new WorkflowEngine({ store, transport, blockedPollMs: 10 });
    engine.register('checkout', '1', async (ctx) => {
      const r = await ctx.step<{ charged: boolean }>(
        'billing.charge',
        { amount: 1 },
        {
          requires: ['saga'],
        },
      );
      return r.charged;
    });

    await engine.start('checkout', {}, 'run1');
    const blocked = await settle(store, 'run1');
    expect(blocked.status).toBe('blocked');
    expect(transport.dispatched).toHaveLength(0);

    // A capable worker joins the fleet. The blocked-recovery poll re-drives the run.
    transport.descriptors = [worker({ instanceId: 'w2', capabilities: ['saga'] })];
    await engine.resumeDueTimers(Date.now() + 1000);
    const run = await settle(store, 'run1');

    expect(run.status).toBe('completed');
    expect(run.output).toBe(true);
    expect(transport.dispatched).toHaveLength(1);
  });

  it('does NOT engage the guard when no descriptors are published (legacy assume-compatible dispatch)', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    transport.handle('billing.charge', () => ({ ok: true }));
    // No live descriptors published — a pre-handshake fleet. The guard must not block a required step.
    transport.descriptors = [];

    const engine = new WorkflowEngine({ store, transport });
    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('billing.charge', { amount: 1 }, { requires: ['saga'] });
      return 'done';
    });

    await engine.start('checkout', {}, 'run1');
    const run = await settle(store, 'run1');

    expect(run.status).toBe('completed');
    expect(transport.dispatched).toHaveLength(1);
  });
});

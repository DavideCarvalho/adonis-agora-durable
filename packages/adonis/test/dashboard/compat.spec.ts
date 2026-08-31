import { describe, expect, it } from 'vitest';
import { type CompatSource, compat } from '../../src/dashboard/compat.js';
import { BlockedDiagnosticsRecorder } from '../../src/dashboard/diagnostics-recorder.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowRun,
  WorkflowStepEvent,
} from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A full worker descriptor with test-friendly defaults (control plane speaks protocol v1). */
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

function run(partial: Partial<WorkflowRun> & { id: string }): WorkflowRun {
  return {
    workflow: 'checkout',
    workflowVersion: '1',
    status: 'blocked',
    input: {},
    createdAt: new Date('2026-07-17T00:00:00Z'),
    updatedAt: new Date('2026-07-17T00:00:01Z'),
    ...partial,
  } as WorkflowRun;
}

/** A minimal CompatSource backed by plain arrays — the handler is pure over it. */
function source(over: Partial<CompatSource> = {}): CompatSource {
  return {
    controlPlaneDescriptor: () => worker({ instanceId: 'cp' }),
    fleet: () => [],
    blockedRuns: async () => [],
    diagnosticsFor: () => undefined,
    ...over,
  };
}

type CompatBody = {
  controlPlane: { instanceId: string; protocol: number; capabilities: string[] };
  groups: Array<{
    token: string;
    incompatible: boolean;
    degraded: boolean;
    pods: Array<{
      instanceId: string;
      protocol: number;
      outcome: string;
      incompatible: boolean;
      reason?: string;
      missingOnRemote: string[];
    }>;
  }>;
  blocked: Array<{
    id: string;
    reason: string;
    code?: string;
    requires: string[];
    missingCapabilities?: string[];
    workerRanges?: [number, number][];
  }>;
  incompatibleCount: number;
  blockedCount: number;
};

describe('compat handler — per-pod protocol compatibility', () => {
  it('flags an incompatible worker (protocol major mismatch) with the exact reason', async () => {
    const res = await compat(
      source({
        controlPlaneDescriptor: () =>
          worker({ instanceId: 'cp', protocol: { version: 1, range: [1, 1] } }),
        fleet: () => [
          {
            token: 'billing.charge@acme',
            workers: [
              worker({
                instanceId: 'py-1',
                runtime: 'python',
                protocol: { version: 2, range: [2, 2] },
              }),
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = res.body as CompatBody;

    const group = body.groups.find((g) => g.token === 'billing.charge@acme');
    expect(group?.incompatible).toBe(true);
    const pod = group?.pods[0];
    expect(pod?.instanceId).toBe('py-1');
    expect(pod?.protocol).toBe(2);
    expect(pod?.outcome).toBe('incompatible');
    expect(pod?.incompatible).toBe(true);
    // The LOUD, structured reason — the whole point of the red flag (design §7.6).
    expect(pod?.reason).toContain('no common protocol major');
    expect(pod?.reason).toContain('local speaks [1, 1]');
    expect(pod?.reason).toContain('remote speaks [2, 2]');
    expect(body.incompatibleCount).toBe(1);
  });

  it('marks a degraded worker (missing capability) but does not flag it incompatible', async () => {
    const res = await compat(
      source({
        controlPlaneDescriptor: () => worker({ instanceId: 'cp', capabilities: ['saga'] }),
        fleet: () => [{ token: 'wf@t', workers: [worker({ instanceId: 'w1', capabilities: [] })] }],
      }),
    );
    const body = res.body as CompatBody;
    const pod = body.groups[0]?.pods[0];
    expect(pod?.outcome).toBe('degraded');
    expect(pod?.incompatible).toBe(false);
    expect(pod?.missingOnRemote).toContain('saga');
    expect(body.groups[0]?.degraded).toBe(true);
    expect(body.incompatibleCount).toBe(0);
  });

  it('marks a fully-parity worker compatible with no reason', async () => {
    const res = await compat(
      source({
        controlPlaneDescriptor: () => worker({ instanceId: 'cp' }),
        fleet: () => [{ token: 'wf@t', workers: [worker({ instanceId: 'w1' })] }],
      }),
    );
    const pod = (res.body as CompatBody).groups[0]?.pods[0];
    expect(pod?.outcome).toBe('compatible');
    expect(pod?.incompatible).toBe(false);
    expect(pod?.reason).toBeUndefined();
  });
});

describe('compat handler — blocked runs', () => {
  it('lists a blocked run with its human reason', async () => {
    const res = await compat(
      source({
        blockedRuns: async () => [
          run({
            id: 'run-1',
            error: { message: 'blocked: no compatible worker (requires saga)', retryable: true },
          }),
        ],
      }),
    );
    const body = res.body as CompatBody;
    expect(body.blockedCount).toBe(1);
    const blocked = body.blocked[0];
    expect(blocked?.id).toBe('run-1');
    // The human reason must render — this is the mutation target.
    expect(blocked?.reason).toBe('blocked: no compatible worker (requires saga)');
  });

  it('enriches a blocked run with the captured diagnostics delta (code + missing caps)', async () => {
    const res = await compat(
      source({
        blockedRuns: async () => [
          run({
            id: 'run-2',
            error: { message: 'blocked: no compatible worker (requires saga)', retryable: true },
          }),
        ],
        diagnosticsFor: (runId) =>
          runId === 'run-2'
            ? {
                code: 'capability.unavailable',
                reason: 'blocked: no compatible worker (requires saga)',
                at: '2026-07-17T00:00:00Z',
                diagnostics: {
                  code: 'capability.unavailable',
                  token: 'billing@acme',
                  requires: ['saga'],
                  liveWorkers: 1,
                  missingCapabilities: ['saga'],
                  controlPlane: worker({ instanceId: 'cp' }),
                  workers: [worker({ instanceId: 'w1', capabilities: ['signals'] })],
                },
              }
            : undefined,
      }),
    );
    const blocked = (res.body as CompatBody).blocked[0];
    expect(blocked?.code).toBe('capability.unavailable');
    expect(blocked?.requires).toEqual(['saga']);
    expect(blocked?.missingCapabilities).toEqual(['saga']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a REAL engine parks a run blocked; the recorder captures the loud
// event; the compat handler renders the flag + reason. Break the render → this fails.
// ---------------------------------------------------------------------------

/** In-process transport advertising handshake descriptors, so the engine's guard blocks a run. */
class CapabilityTransport implements Transport {
  descriptors: WorkerDescriptor[] = [];
  readonly dispatched: RemoteTask[] = [];
  private resultHandler?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  onStepEvent(_h: (e: WorkflowStepEvent) => Promise<void>): void {}
  async listWorkerDescriptors(_token: string): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
}

async function settle(store: InMemoryStateStore, runId: string, max = 100): Promise<WorkflowRun> {
  for (let i = 0; i < max; i += 1) {
    await new Promise((r) => setImmediate(r));
    const r = await store.getRun(runId);
    if (r && r.status !== 'running' && r.status !== 'pending' && r.status !== 'suspended') return r;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('compat handler — end-to-end over a real blocked run', () => {
  it('renders the protocol-incompatible flag + blocked reason captured from a real engine', async () => {
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    // Capable worker, but on protocol major 2 — the control plane speaks v1 → incompatible.
    transport.descriptors = [
      worker({
        instanceId: 'py-1',
        runtime: 'python',
        capabilities: ['saga'],
        protocol: { version: 2, range: [2, 2] },
      }),
    ];
    const engine = new WorkflowEngine({ store, transport });

    const recorder = new BlockedDiagnosticsRecorder();
    const detach = recorder.attach(engine);

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('billing.charge', { amount: 1 }, { requires: ['saga'] });
      return 'done';
    });
    await engine.start('checkout', {}, 'run-e2e');
    const parked = await settle(store, 'run-e2e');
    expect(parked.status).toBe('blocked');

    const src: CompatSource = {
      controlPlaneDescriptor: () => recorder.controlPlaneDescriptor(),
      fleet: () => recorder.fleet(),
      blockedRuns: () => engine.listRuns({ statuses: ['blocked'] }),
      diagnosticsFor: (id) => recorder.diagnosticsFor(id),
    };
    const body = (await compat(src)).body as CompatBody;

    // The blocked run renders with its human reason.
    expect(body.blockedCount).toBe(1);
    expect(body.blocked[0]?.id).toBe('run-e2e');
    expect(body.blocked[0]?.reason).toContain('no protocol-compatible worker');
    expect(body.blocked[0]?.code).toBe('protocol.incompatible');
    expect(body.blocked[0]?.workerRanges).toEqual([[2, 2]]);

    // The per-pod compat view (reconstructed from the loud event) flags the incompatible worker.
    expect(body.incompatibleCount).toBe(1);
    const pod = body.groups.flatMap((g) => g.pods).find((p) => p.instanceId === 'py-1');
    expect(pod?.incompatible).toBe(true);
    expect(pod?.reason).toContain('no common protocol major');

    detach();
  });
});

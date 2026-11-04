import { describe, expect, it } from 'vitest';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { getRun, workflowLifecycle } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import { runCompletedEvent, runFailedEvent } from '../../src/lifecycle-events.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

class FleetTransport extends InMemoryTransport {
  constructor(readonly descriptors: WorkerDescriptor[]) {
    super();
  }
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
}

function pythonWorker(workflow: string, subscribes: string[]): WorkerDescriptor {
  return {
    instanceId: 'py-1',
    runtime: 'python',
    sdk: { name: 'durable-worker', version: '0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [workflow],
    steps: [],
    registrations: [{ name: workflow, subscribes }],
    startedAt: 0,
  };
}

function setup() {
  const store = new InMemoryStateStore();
  const transport = new FleetTransport([
    pythonWorker('notify', [runCompletedEvent('ingest'), runFailedEvent('ingest')]),
    pythonWorker('ingest', [runCompletedEvent('upload')]),
  ]);
  const engine = new WorkflowEngine({ store, transport });
  engine.register('ingest', '1', async () => 'ok');
  engine.register('refresh', '1', async () => 'ok', {
    onEvent: [
      {
        event: runCompletedEvent('ingest'),
        where: (e) => (e as { output: unknown }).output === 'ok',
        input: (e) => ({ source: (e as { runId: string }).runId }),
      },
    ],
    eventBatch: { mode: 'debounce', windowMs: 1000, key: (input) => String(input) },
  });
  engine.register('alert', '1', async () => 'ok', { onEvent: [runFailedEvent('ingest')] });
  return { store, engine };
}

describe('engine.workflowLifecycle', () => {
  it('lists who starts when a workflow settles and who starts it, local and announced', async () => {
    const { engine } = setup();

    expect(await engine.workflowLifecycle('ingest')).toEqual({
      workflow: 'ingest',
      startsOnSettle: [
        {
          workflow: 'alert',
          kind: 'failed',
          local: true,
          announced: false,
          where: false,
          input: false,
        },
        {
          workflow: 'notify',
          kind: 'completed',
          local: false,
          announced: true,
          where: false,
          input: false,
        },
        {
          workflow: 'notify',
          kind: 'failed',
          local: false,
          announced: true,
          where: false,
          input: false,
        },
        {
          workflow: 'refresh',
          kind: 'completed',
          local: true,
          announced: false,
          where: true,
          input: true,
          coalesce: { mode: 'debounce', keyed: true },
        },
      ],
      startedBy: [
        {
          workflow: 'upload',
          kind: 'completed',
          local: false,
          announced: true,
          where: false,
          input: false,
        },
      ],
    });
    expect(await engine.workflowLifecycle('refresh')).toEqual({
      workflow: 'refresh',
      startsOnSettle: [],
      startedBy: [expect.objectContaining({ workflow: 'ingest', kind: 'completed', local: true })],
    });
    expect(await engine.workflowLifecycle('nobody')).toEqual({
      workflow: 'nobody',
      startsOnSettle: [],
      startedBy: [],
    });
  });

  it('marks a subscriber both registered here and announced as both', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: new FleetTransport([pythonWorker('refresh', [runCompletedEvent('ingest')])]),
    });
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    expect((await engine.workflowLifecycle('ingest')).startsOnSettle).toEqual([
      {
        workflow: 'refresh',
        kind: 'completed',
        local: true,
        announced: true,
        where: false,
        input: false,
      },
    ]);
  });

  it('answers from the local registry alone when the fleet cannot be read', async () => {
    const store = new InMemoryStateStore();
    const transport = new FleetTransport([]);
    transport.readAllWorkerDescriptors = async () => {
      throw new Error('redis down');
    };
    const engine = new WorkflowEngine({ store, transport });
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    expect((await engine.workflowLifecycle('ingest')).startsOnSettle).toEqual([
      expect.objectContaining({ workflow: 'refresh', local: true, announced: false }),
    ]);
  });
});

describe('workflow lifecycle links over the gateway', () => {
  it('serves GET /workflows/:name/lifecycle', async () => {
    const { engine } = setup();
    const deps = { engine: storeDashboardEngine(engine) };
    const res = await workflowLifecycle(deps, { params: { name: 'refresh' }, query: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workflow: 'refresh',
      startsOnSettle: [],
      startedBy: [expect.objectContaining({ workflow: 'ingest', kind: 'completed' })],
    });
  });

  it('answers 404 on a topology without it', async () => {
    const { engine } = setup();
    const { workflowLifecycle: _drop, ...rest } = storeDashboardEngine(engine);
    const res = await workflowLifecycle({ engine: rest }, { params: { name: 'x' }, query: {} });
    expect(res.status).toBe(404);
  });

  it('forwards through the store run gateway', async () => {
    const { engine } = setup();
    const gateway = new StoreRunGateway(engine);
    expect((await gateway.workflowLifecycle('ingest')).startedBy).toEqual([
      expect.objectContaining({ workflow: 'upload' }),
    ]);
  });

  it("carries the run's workflow links on the run detail, and leaves them out when there are none", async () => {
    const { engine } = setup();
    engine.register('lonely', '1', async () => 'ok');
    await engine.start('ingest', {}, 'i1');
    await engine.start('lonely', {}, 'l1');
    await engine.waitForRun('i1');
    await engine.waitForRun('l1');
    const deps = { engine: storeDashboardEngine(engine) };

    const detail = (await getRun(deps, { params: { id: 'i1' }, query: {} })).body as {
      workflowLifecycle?: { workflow: string; startsOnSettle: unknown[] };
    };
    expect(detail.workflowLifecycle?.workflow).toBe('ingest');
    expect(detail.workflowLifecycle?.startsOnSettle).toHaveLength(4);
    const lonely = (await getRun(deps, { params: { id: 'l1' }, query: {} })).body as object;
    expect(lonely).not.toHaveProperty('workflowLifecycle');
  });
});

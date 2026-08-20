import { describe, expect, it } from 'vitest';
import { NamespaceMismatch, WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records the routing token of every dispatch, and completes each task so runs can settle. */
class RoutingSpyTransport implements Transport {
  readonly groups: string[] = [];
  private resultHandler?: (r: StepResult) => Promise<void>;
  private readonly handlers = new Map<string, (input: unknown) => unknown>();

  handle(name: string, fn: (input: unknown) => unknown): void {
    this.handlers.set(name, fn);
  }
  async dispatch(task: RemoteTask): Promise<void> {
    this.groups.push(task.group);
    const fn = this.handlers.get(task.name);
    const result: StepResult = {
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'completed',
      output: fn ? fn(task.input) : null,
    };
    setImmediate(() => void this.resultHandler?.(result));
  }
  onResult(handler: (r: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }
  onHeartbeat(_handler: (b: Heartbeat) => Promise<void>): void {}
}

/** A pending run belonging to `namespace`, as another pool's engine would have created it. */
async function seedRun(store: InMemoryStateStore, id: string, namespace?: string) {
  const now = new Date();
  await store.createRun({
    id,
    workflow: 'w',
    workflowVersion: '1',
    status: 'pending',
    input: {},
    ...(namespace !== undefined ? { namespace } : {}),
    createdAt: now,
    updatedAt: now,
  });
}

describe('operator (no namespace) drives every namespace', () => {
  it('resumes a run belonging to another pool', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store });
    operator.register('w', '1', async () => 'ok');
    await seedRun(store, 'r1', 'acme');

    const result = await operator.resume('r1');

    expect(result.status).toBe('completed');
    expect((await store.getRun('r1'))?.namespace).toBe('acme');
  });

  it('polls pending runs of every namespace', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    operator.register('w', '1', async () => 'ok');
    await seedRun(store, 'acme-run', 'acme');
    await seedRun(store, 'globex-run', 'globex');
    await seedRun(store, 'bare-run');

    await operator.runPending();
    await delay(20);

    for (const id of ['acme-run', 'globex-run', 'bare-run']) {
      expect((await store.getRun(id))?.status, id).toBe('completed');
    }
  });

  it('recovers incomplete runs of every namespace', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store });
    operator.register('w', '1', async () => 'ok');
    await seedRun(store, 'r1', 'acme');
    await store.updateRun('r1', { status: 'running' });

    await operator.recoverIncomplete();
    await delay(20);

    expect((await store.getRun('r1'))?.status).toBe('completed');
  });

  it('still refuses a foreign run when the engine IS scoped (isolation intact)', async () => {
    const store = new InMemoryStateStore();
    const scoped = new WorkflowEngine({ store, namespace: 'blue' });
    scoped.register('w', '1', async () => 'ok');
    await seedRun(store, 'r1', 'acme');

    await expect(scoped.resume('r1')).rejects.toBeInstanceOf(NamespaceMismatch);
    expect((await store.getRun('r1'))?.status).toBe('pending');
  });
});

describe('dispatch routes by the RUN namespace, not the engine one', () => {
  it("sends a tenant run's step to the tenant token", async () => {
    const store = new InMemoryStateStore();
    const transport = new RoutingSpyTransport();
    transport.handle('billing.charge', () => ({ charged: true }));
    const operator = new WorkflowEngine({ store, transport });
    operator.register('w', '1', async (ctx) => ctx.step('billing.charge', {}));
    await seedRun(store, 'r1', 'acme');

    await operator.resume('r1');
    await delay(20);

    expect(transport.groups).toEqual(['billing.charge@acme']);
  });

  it('keeps the bare token for the default pool (single-pool deployments unchanged)', async () => {
    const store = new InMemoryStateStore();
    const transport = new RoutingSpyTransport();
    transport.handle('billing.charge', () => ({ charged: true }));
    const engine = new WorkflowEngine({ store, transport });
    engine.register('w', '1', async (ctx) => ctx.step('billing.charge', {}));
    await seedRun(store, 'r1');

    await engine.resume('r1');
    await delay(20);

    expect(transport.groups).toEqual(['billing.charge']);
    expect((await store.getRun('r1'))?.namespace).toBe('default');
  });
});

describe('a child run inherits the parent run namespace', () => {
  it('stamps ctx.child with the parent pool even on an operator', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store });
    operator.register('child', '1', async () => 'done');
    operator.register('parent', '1', async (ctx) => ctx.child('child', {}));
    await store.createRun({
      id: 'p1',
      workflow: 'parent',
      workflowVersion: '1',
      status: 'pending',
      input: {},
      namespace: 'acme',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await operator.resume('p1');
    await delay(30);

    const childIds = await operator.getRunChildren('p1');
    expect(childIds).toHaveLength(1);
    expect((await store.getRun(childIds[0] as string))?.namespace).toBe('acme');
  });
});

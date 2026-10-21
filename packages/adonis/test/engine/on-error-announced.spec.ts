import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type { EngineEvent, WorkflowDecision, WorkflowTask } from '../../src/interfaces.js';
import type { OnErrorInput } from '../../src/on-error.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

async function until(check: () => boolean | Promise<boolean>, max = 2000): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition not met');
}

type Route = { code?: string; workflow: string };

/**
 * Stand-in for a Python worker serving `py-line` by convention: it announces the workflow (and its
 * onError routes) in its descriptor, and every turn records a failed `validate` step and fails.
 * A second route set makes it a fleet of two workers that disagree.
 */
class PythonLineWorker extends InMemoryTransport {
  readonly turns: number[][] = [];
  private decide?: (decision: WorkflowDecision) => Promise<void>;
  constructor(
    public routes: Route[],
    private readonly otherRoutes?: Route[],
  ) {
    super();
  }
  async listWorkerGroups(): Promise<string[]> {
    return ['py-line'];
  }
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decide = handler;
  }
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.turns.push(task.history.map((e) => e.seq));
    const error = { message: 'bad line', code: 'invalid_line', retryable: false };
    const commands = task.history.some((e) => e.seq === 0)
      ? []
      : [{ kind: 'recordStep' as const, seq: 0, name: 'validate', error }];
    setImmediate(() => {
      void this.decide?.({
        taskId: task.taskId,
        runId: task.runId,
        status: 'failed',
        commands,
        error,
      });
    });
  }
  async listWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    const worker = (id: string, onError: Route[]): WorkerDescriptor => ({
      instanceId: id,
      runtime: 'python',
      sdk: { name: 'durable-worker', version: '0.30.0' },
      protocol: { version: 1, range: [1, 1] },
      capabilities: [],
      workflows: ['py-line'],
      steps: [],
      startedAt: 0,
      registrations: [{ name: 'py-line', group: 'py-line', onError }],
    });
    return [
      worker('py-1', this.routes),
      ...(this.otherRoutes ? [worker('py-2', this.otherRoutes)] : []),
    ];
  }
}

describe('onError routes announced by the workers of a convention-served workflow', () => {
  it('routes the failure by the routes its workers announce, in one turn', async () => {
    const store = new InMemoryStateStore();
    const worker = new PythonLineWorker([{ code: 'invalid_line', workflow: 'line.invalid' }]);
    const engine = new WorkflowEngine({ store, transport: worker, reconcileMs: 0 });
    engine.register('line.invalid', '1', async (_ctx, input) => ({
      deadLettered: (input as OnErrorInput).error.code,
    }));

    await engine.start('py-line', { n: 1 }, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'completed');

    expect((await store.getRun('r'))?.output).toEqual({ deadLettered: 'invalid_line' });
    // Once the failure is handed off, the body is never dispatched again.
    expect(worker.turns).toEqual([[]]);
  });

  it('does not route, and says so, when the live workers announce different routes', async () => {
    const store = new InMemoryStateStore();
    const worker = new PythonLineWorker(
      [{ code: 'invalid_line', workflow: 'line.invalid' }],
      [{ code: 'invalid_line', workflow: 'line.invalid.v2' }],
    );
    const engine = new WorkflowEngine({ store, transport: worker, reconcileMs: 0 });
    engine.register('line.invalid', '1', async () => 'handled');
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.start('py-line', {}, 'r');
    await until(async () => (await store.getRun('r'))?.status === 'failed');

    expect(await store.getRun('r.onError.0')).toBeNull();
    expect(events.find((e) => e.type === 'run.unrouted')).toMatchObject({
      runId: 'r',
      error: expect.objectContaining({ code: 'invalid_line' }),
      reason: expect.stringContaining('2 different onError route sets'),
    });
  });

  it('reuses the announced routes it read for a burst of failures', async () => {
    const store = new InMemoryStateStore();
    const worker = new PythonLineWorker([{ code: 'invalid_line', workflow: 'line.invalid' }]);
    const engine = new WorkflowEngine({ store, transport: worker, reconcileMs: 0 });
    engine.register('line.invalid', '1', async () => 'handled');
    engine.register('line.other', '1', async () => 'other');

    await engine.start('py-line', {}, 'a');
    await until(async () => (await store.getRun('a'))?.status === 'completed');
    // A new announcement inside the cache window is not read yet: the second failure goes where the
    // first one did.
    worker.routes = [{ code: 'invalid_line', workflow: 'line.other' }];
    await engine.start('py-line', {}, 'b');
    await until(async () => (await store.getRun('b'))?.status === 'completed');

    expect((await store.getRun('b'))?.output).toBe('handled');
  });
});

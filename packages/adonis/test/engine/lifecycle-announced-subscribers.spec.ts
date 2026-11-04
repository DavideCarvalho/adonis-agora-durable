import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type {
  EngineEvent,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from '../../src/interfaces.js';
import {
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  lifecycleRunId,
  runCompletedEvent,
} from '../../src/lifecycle-events.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * A fleet as an engine sees it: published worker descriptors, live worker groups, and workflow
 * turns, each answered `completed` with the turn's input, as a Python worker serving them would.
 */
class FleetTransport extends InMemoryTransport {
  readonly turns: WorkflowTask[] = [];
  private decide?: (decision: WorkflowDecision) => Promise<void>;
  constructor(
    readonly board: Map<string, WorkerDescriptor>,
    readonly groups: string[],
  ) {
    super();
  }
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return [...this.board.values()];
  }
  async listWorkerGroups(): Promise<string[]> {
    return this.groups;
  }
  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.turns.push(task);
    setImmediate(() => {
      void this.decide?.({
        taskId: task.taskId,
        runId: task.runId,
        status: 'completed',
        commands: [],
        output: 'notified',
      });
    });
  }
  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decide = handler;
  }
}

/** The descriptor a worker of `runtime` publishes for `workflow`, subscribing it to `events`. */
function announcing(
  workflow: string,
  events: string[],
  runtime: 'node' | 'python' = 'python',
): WorkerDescriptor {
  return {
    instanceId: `${runtime}-1`,
    runtime,
    sdk: { name: runtime === 'python' ? 'durable-worker' : 'test', version: '0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [workflow],
    steps: [],
    registrations: [{ name: workflow, subscribes: events }],
    startedAt: 0,
  };
}

const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

describe('lifecycle subscribers known only from announcements', () => {
  it('starts a Python subscriber by name under the lifecycle id, with the event as input', async () => {
    const store = new InMemoryStateStore();
    const board = new Map([['py', announcing('notify', [runCompletedEvent('ingest')])]]);
    const transport = new FleetTransport(board, ['notify']);
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => ({ rows: 3 }));
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.sweepLifecycleEvents();

    await engine.start('ingest', { file: 'a.csv' }, 'i1', { tags: ['etl'] });
    const id = lifecycleRunId('i1', 'completed', 'notify');
    await poll(async () => (await store.getRun(id))?.status === 'completed');
    await settle();

    const subscriber = (await store.getRun(id)) as WorkflowRun;
    expect(subscriber.workflow).toBe('notify');
    expect(subscriber.input).toEqual(
      expect.objectContaining({
        runId: 'i1',
        workflow: 'ingest',
        status: 'completed',
        input: { file: 'a.csv' },
        output: { rows: 3 },
        tags: ['etl'],
      }),
    );
    expect(transport.turns.map((t) => [t.runId, t.group])).toEqual([[id, 'notify']]);
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual(['durable:triggered:notify', 'etl']);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'run.triggered', runId: 'i1', name: 'notify' }),
    );
  });

  it('starts it from the sweep once its worker group is live', async () => {
    const store = new InMemoryStateStore();
    const board = new Map([['py', announcing('notify', [runCompletedEvent('ingest')])]]);
    const transport = new FleetTransport(board, []);
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => 'ok');
    await engine.sweepLifecycleEvents();

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    // Announced but not reachable from here yet: still owed, nothing started.
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('notify')]);
    expect(await store.getRun(lifecycleRunId('i1', 'completed', 'notify'))).toBeNull();

    transport.groups.push('notify');
    expect(await engine.sweepLifecycleEvents(Date.now() + 31_000)).toBe(1);
    await poll(
      async () =>
        (await store.getRun(lifecycleRunId('i1', 'completed', 'notify')))?.status === 'completed',
    );
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:notify']);
  });

  it('starts a subscriber registered here once, through its local subscription', async () => {
    const store = new InMemoryStateStore();
    const board = new Map([['py', announcing('notify', [runCompletedEvent('ingest')])]]);
    const transport = new FleetTransport(board, ['notify']);
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => 'ok');
    const inputs: unknown[] = [];
    engine.register('notify', '1', async (_ctx, input) => void inputs.push(input), {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          input: (e) => ({ source: (e as { runId: string }).runId }),
        },
      ],
    });
    const triggered: EngineEvent[] = [];
    engine.subscribe((e) => e.type === 'run.triggered' && triggered.push(e));
    await engine.sweepLifecycleEvents();

    await engine.start('ingest', {}, 'i1');
    await poll(async () => inputs.length === 1);
    await settle();
    await engine.sweepLifecycleEvents(Date.now() + 31_000);
    await settle();

    expect(inputs).toEqual([{ source: 'i1' }]);
    expect(transport.turns).toEqual([]);
    expect(triggered).toHaveLength(1);
  });

  it('leaves a subscriber a Node engine announces to that engine', async () => {
    const store = new InMemoryStateStore();
    const board = new Map([['b', announcing('notify', [runCompletedEvent('ingest')], 'node')]]);
    // A live group of the same name does not make it startable here: its own engine applies its
    // `where` and `input`.
    const transport = new FleetTransport(board, ['notify']);
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => 'ok');
    await engine.sweepLifecycleEvents();

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    await engine.sweepLifecycleEvents(Date.now() + 31_000);

    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('notify')]);
    expect(transport.turns).toEqual([]);
  });

  it('backfills a Python subscriber through republishLifecycle', async () => {
    const store = new InMemoryStateStore();
    const board = new Map<string, WorkerDescriptor>();
    const transport = new FleetTransport(board, ['notify']);
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => 'ok');
    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');

    // The Python subscriber is deployed after the run settled; a later instance sees it announced.
    board.set('py', announcing('notify', [runCompletedEvent('ingest')]));
    const later = new WorkflowEngine({ store, transport });
    await later.sweepLifecycleEvents();
    expect(await later.republishLifecycle({ workflow: 'ingest' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    expect(await later.republishLifecycle({ workflow: 'ingest' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
  });
});

describe('event subscribers known only from announcements', () => {
  it('starts a Python on_event subscriber from publishEvent, by name', async () => {
    const store = new InMemoryStateStore();
    const board = new Map([['py', announcing('on-upload', ['upload.received'])]]);
    const transport = new FleetTransport(board, ['on-upload']);
    const engine = new WorkflowEngine({ store, transport });

    expect(await engine.publishEvent('upload.received', { file: 'a.csv' }, { id: 'e1' })).toBe(1);
    const run = await store.getRun('evt:e1:on-upload');
    expect(run?.workflow).toBe('on-upload');
    expect(run?.input).toEqual({ file: 'a.csv' });
    // Idempotent by event id.
    await engine.publishEvent('upload.received', { file: 'a.csv' }, { id: 'e1' });
    await poll(async () => (await store.getRun('evt:e1:on-upload'))?.status === 'completed');
    expect(transport.turns.map((t) => t.runId)).toEqual(['evt:e1:on-upload']);
  });

  it('buffers the event when the announced subscriber is not reachable', async () => {
    const store = new InMemoryStateStore();
    const board = new Map([['py', announcing('on-upload', ['upload.received'])]]);
    const engine = new WorkflowEngine({ store, transport: new FleetTransport(board, []) });

    expect(await engine.publishEvent('upload.received', {}, { id: 'e1' })).toBe(0);
    expect(await store.getRun('evt:e1:on-upload')).toBeNull();
  });
});

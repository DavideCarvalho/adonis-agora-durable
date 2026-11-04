import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type { EngineEvent, WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  lifecycleRegistryRunId,
  lifecycleRunId,
  runCompletedEvent,
  triggeredRunsOf,
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

/** A transport whose descriptor keyspace is a map every engine built on the same board reads. */
class FleetTransport extends InMemoryTransport {
  constructor(
    readonly board: Map<string, WorkerDescriptor>,
    readonly reads: { fail: boolean } = { fail: false },
  ) {
    super();
  }
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    if (this.reads.fail) throw new Error('redis down');
    return [...this.board.values()];
  }
}

/** A descriptor a live worker publishes for `workflow`, subscribing it to `events`. */
function announcing(workflow: string, events: string[], instanceId = 'remote-1'): WorkerDescriptor {
  return {
    instanceId,
    runtime: 'node',
    sdk: { name: 'test', version: '0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [workflow],
    steps: [],
    registrations: [{ name: workflow, subscribes: events }],
    startedAt: 0,
  };
}

const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

describe('lifecycle subscriptions announced by the fleet', () => {
  it('delivers once to each subscriber when two engines register different ones', async () => {
    const store = new InMemoryStateStore();
    const board = new Map<string, WorkerDescriptor>();
    const a = new WorkflowEngine({ store, transport: new FleetTransport(board), instanceId: 'a' });
    const b = new WorkflowEngine({ store, transport: new FleetTransport(board), instanceId: 'b' });
    const ran = { x: 0, y: 0 };
    for (const engine of [a, b]) engine.register('ingest', '1', async () => 'ok');
    a.register('x', '1', async () => void ran.x++, { onEvent: [runCompletedEvent('ingest')] });
    b.register('y', '1', async () => void ran.y++, { onEvent: [runCompletedEvent('ingest')] });

    // Each engine's tick writes its registry row and reads the other's.
    await b.sweepLifecycleEvents();
    await a.sweepLifecycleEvents();

    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun(lifecycleRunId('i1', 'completed', 'x'))) !== null);
    await poll(async () => !(await store.getRun('i1'))?.tags?.includes(owed('x')));
    // A delivered its own subscriber and left Y's owed tag (and the pending marker) for B.
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual(
      [LIFECYCLE_PENDING_TAG, owed('y'), 'durable:triggered:x'].sort(),
    );

    const later = Date.now() + 31_000;
    await a.sweepLifecycleEvents(later);
    expect(await store.getRun(lifecycleRunId('i1', 'completed', 'y'))).toBeNull();
    await b.sweepLifecycleEvents(later);
    await poll(
      async () =>
        (await store.getRun(lifecycleRunId('i1', 'completed', 'y')))?.status === 'completed',
    );
    await settle();
    await a.sweepLifecycleEvents(later);
    await b.sweepLifecycleEvents(later);
    await settle();

    const run = (await store.getRun('i1')) as WorkflowRun;
    expect(run.tags?.sort()).toEqual(['durable:triggered:x', 'durable:triggered:y']);
    expect(triggeredRunsOf(run).sort()).toEqual([
      lifecycleRunId('i1', 'completed', 'x'),
      lifecycleRunId('i1', 'completed', 'y'),
    ]);
    expect(ran).toEqual({ x: 1, y: 1 });
  });

  it('owes the event to a subscriber only a live worker announces', async () => {
    const store = new InMemoryStateStore();
    const board = new Map([['w', announcing('remote-sub', [runCompletedEvent('ingest')])]]);
    const engine = new WorkflowEngine({ store, transport: new FleetTransport(board) });
    engine.register('ingest', '1', async () => 'ok');
    await engine.sweepLifecycleEvents();

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('remote-sub')]);
    expect(engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['remote-sub']);

    // Not registered here: the sweep leaves it to the instance that has it.
    await engine.sweepLifecycleEvents(Date.now() + 60_000);
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('remote-sub')]);
  });

  it('announces its own subscribers in the registry, not through the transport', async () => {
    const board = new Map<string, WorkerDescriptor>();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: new FleetTransport(board),
      instanceId: 'me',
    });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('alert', '2', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest'), 'run.failed:ingest'],
    });
    await engine.sweepLifecycleEvents();

    expect(board.size).toBe(0);
    expect((await store.getRun(lifecycleRegistryRunId('me')))?.input).toEqual({
      instanceId: 'me',
      runtime: 'node',
      engineNamespace: null,
      subscriptions: [{ workflow: 'alert', events: ['run.completed:ingest', 'run.failed:ingest'] }],
    });
  });

  it('drops an owed subscriber no live worker announces, 24h after the run settled', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      transport: new FleetTransport(new Map()),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const settledAt = 1_000_000;
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      output: 'ok',
      tags: ['etl', LIFECYCLE_PENDING_TAG, owed('gone')],
      createdAt: new Date(settledAt),
      updatedAt: new Date(settledAt),
    } as WorkflowRun);

    await engine.sweepLifecycleEvents(settledAt + LIFECYCLE_ORPHAN_MS - 1);
    expect((await store.getRun('i1'))?.tags).toEqual(['etl', LIFECYCLE_PENDING_TAG, owed('gone')]);

    await engine.sweepLifecycleEvents(settledAt + LIFECYCLE_ORPHAN_MS);
    expect((await store.getRun('i1'))?.tags).toEqual(['etl', 'durable:trigger_failed:gone']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.trigger_failed',
        runId: 'i1',
        name: 'gone',
        error: { message: 'subscriber gone is not registered on any live worker' },
      }),
    );
  });

  it('keeps an owed subscriber a live worker still announces, or while the fleet cannot be read', async () => {
    const store = new InMemoryStateStore();
    const board = new Map<string, WorkerDescriptor>();
    const reads = { fail: false };
    const engine = new WorkflowEngine({ store, transport: new FleetTransport(board, reads) });
    const run = {
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG, owed('elsewhere')],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun;
    await store.createRun(run);
    const later = LIFECYCLE_ORPHAN_MS * 2;

    reads.fail = true;
    await engine.sweepLifecycleEvents(later);
    expect((await store.getRun('i1'))?.tags).toEqual(run.tags);

    reads.fail = false;
    board.set('w', announcing('elsewhere', [runCompletedEvent('ingest')]));
    const fresh = new WorkflowEngine({ store, transport: new FleetTransport(board, reads) });
    await fresh.sweepLifecycleEvents(later);
    expect((await store.getRun('i1'))?.tags).toEqual(run.tags);
  });

  it('republishes for a subscriber registered elsewhere by marking it owed for that sweep', async () => {
    const store = new InMemoryStateStore();
    const a = new WorkflowEngine({ store });
    const b = new WorkflowEngine({ store });
    let ran = 0;
    for (const engine of [a, b]) engine.register('ingest', '1', async () => 'ok');
    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    // The subscriber is deployed on B after the run settled.
    b.register('late', '1', async () => void ran++, { onEvent: [runCompletedEvent('ingest')] });

    expect(await a.republishLifecycle({ runId: 'i1', subscriber: 'late' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
    expect((await store.getRun('i1'))?.tags?.sort()).toEqual(
      [LIFECYCLE_PENDING_TAG, owed('late')].sort(),
    );
    await b.sweepLifecycleEvents(Date.now() + 31_000);
    await poll(async () => ran === 1);
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:late']);
  });

  it('treats a run marked pending with no owed tag as owed to every local subscriber', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('refresh', '1', async () => void runs++, {
      onEvent: [runCompletedEvent('ingest')],
    });
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun);

    expect(await engine.sweepLifecycleEvents(60_000)).toBe(1);
    await poll(
      async () =>
        (await store.getRun(lifecycleRunId('i1', 'completed', 'refresh')))?.status === 'completed',
    );
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:triggered:refresh']);
    expect(runs).toBe(1);
  });

  it('does not delay a terminal write on the fleet read', async () => {
    const store = new InMemoryStateStore();
    let reads = 0;
    const transport = new FleetTransport(new Map());
    const read = transport.readAllWorkerDescriptors.bind(transport);
    transport.readAllWorkerDescriptors = async () => {
      reads += 1;
      return read();
    };
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => 'ok');
    for (let i = 0; i < 5; i += 1) await engine.start('ingest', {}, `i${i}`);
    await settle();
    // One read for the burst: the snapshot is reused for its TTL.
    expect(reads).toBe(1);
  });
});

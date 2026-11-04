import { describe, expect, it } from 'vitest';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { listRuns as listRunsHandler, runValues } from '../../src/dashboard/handlers.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type { RunQuery, WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_REGISTRY_HEARTBEAT_MS,
  LIFECYCLE_REGISTRY_STALE_MS,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_TTL_MS,
  LIFECYCLE_REGISTRY_WORKFLOW,
  type LifecycleRegistryEntry,
  lifecycleRegistryRunId,
  lifecycleRegistrySubscriptions,
  lifecycleRunId,
  retentionKeeps,
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

const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

/** A registry row as an engine `instanceId` that beat at `beatAt` leaves it. */
function registryRow(
  instanceId: string,
  subscriptions: LifecycleRegistryEntry['subscriptions'],
  beatAt: number,
): WorkflowRun {
  return {
    id: lifecycleRegistryRunId(instanceId),
    workflow: LIFECYCLE_REGISTRY_WORKFLOW,
    workflowVersion: '1',
    status: 'completed',
    input: { instanceId, runtime: 'node', subscriptions },
    tags: [LIFECYCLE_REGISTRY_TAG],
    createdAt: new Date(beatAt),
    updatedAt: new Date(beatAt),
  };
}

/** A transport with fleet introspection whose descriptors are fixed (a Python worker's, say). */
class DescriptorTransport extends InMemoryTransport {
  constructor(
    readonly descriptors: WorkerDescriptor[],
    readonly groups: string[] = [],
  ) {
    super();
  }
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
  async listWorkerGroups(): Promise<string[]> {
    return this.groups;
  }
}

describe('lifecycle subscription registry', () => {
  it('delivers once to each subscriber of two engines that share only the store', async () => {
    const store = new InMemoryStateStore();
    // No transport on either side: nothing but the store connects them.
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    const ran = { x: 0, y: 0 };
    for (const engine of [a, b]) engine.register('ingest', '1', async () => 'ok');
    a.register('x', '1', async () => void ran.x++, { onEvent: [runCompletedEvent('ingest')] });
    b.register('y', '1', async () => void ran.y++, { onEvent: [runCompletedEvent('ingest')] });

    await b.sweepLifecycleEvents();
    await a.sweepLifecycleEvents();
    expect(a.lifecycleSubscribers('ingest', 'completed')).toEqual(['x', 'y']);

    await a.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun(lifecycleRunId('i1', 'completed', 'x'))) !== null);
    await poll(async () => !(await store.getRun('i1'))?.tags?.includes(owed('x')));
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

    expect((await store.getRun('i1'))?.tags?.sort()).toEqual([
      'durable:triggered:x',
      'durable:triggered:y',
    ]);
    expect(ran).toEqual({ x: 1, y: 1 });
  });

  it('beats at most once per heartbeat interval, and recreates a row deleted under it', async () => {
    const store = new InMemoryStateStore();
    let now = 1_000_000;
    const engine = new WorkflowEngine({ store, instanceId: 'me', clock: () => now });
    engine.register('alert', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    const id = lifecycleRegistryRunId('me');

    await engine.sweepLifecycleEvents();
    const first = (await store.getRun(id)) as WorkflowRun;
    expect(first).toMatchObject({
      workflow: LIFECYCLE_REGISTRY_WORKFLOW,
      status: 'completed',
      input: {
        instanceId: 'me',
        runtime: 'node',
        subscriptions: [{ workflow: 'alert', events: ['run.completed:ingest'] }],
      },
    });
    expect(first.updatedAt.getTime()).toBe(now);

    now += LIFECYCLE_REGISTRY_HEARTBEAT_MS - 1;
    await engine.sweepLifecycleEvents();
    expect((await store.getRun(id))?.updatedAt.getTime()).toBe(1_000_000);

    now += 1;
    await engine.sweepLifecycleEvents();
    const beat = (await store.getRun(id)) as WorkflowRun;
    expect(beat.updatedAt.getTime()).toBe(now);
    expect(beat.createdAt.getTime()).toBe(now);

    await store.deleteRun(id);
    now += LIFECYCLE_REGISTRY_HEARTBEAT_MS;
    await engine.sweepLifecycleEvents();
    expect((await store.getRun(id))?.updatedAt.getTime()).toBe(now);
  });

  it('writes no row for an engine without subscriptions', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, instanceId: 'plain' });
    engine.register('ingest', '1', async () => 'ok');
    await engine.sweepLifecycleEvents();
    expect(await store.getRun(lifecycleRegistryRunId('plain'))).toBeNull();
  });

  it('counts a row only while its heartbeat is at most the TTL old', async () => {
    const store = new InMemoryStateStore();
    let now = 5_000_000;
    await store.createRun(
      registryRow('b', [{ workflow: 'y', events: [runCompletedEvent('ingest')] }], now),
    );
    const engine = new WorkflowEngine({ store, clock: () => now });
    engine.register('ingest', '1', async () => 'ok');

    await engine.sweepLifecycleEvents();
    expect(engine.lifecycleSubscribers('ingest', 'completed')).toEqual(['y']);

    now += LIFECYCLE_REGISTRY_TTL_MS + 1;
    await engine.sweepLifecycleEvents();
    expect(engine.lifecycleSubscribers('ingest', 'completed')).toEqual([]);
  });

  it('parses only well-formed subscriptions out of a registry input', () => {
    expect(
      lifecycleRegistrySubscriptions({
        instanceId: 'a',
        runtime: 'node',
        subscriptions: [
          { workflow: 'x', events: ['run.completed:ingest', 7, 'upload'] },
          { workflow: 3, events: ['run.completed:ingest'] },
          { workflow: 'y' },
          null,
        ],
      }),
    ).toEqual([{ workflow: 'x', events: ['run.completed:ingest', 'upload'] }]);
    expect(lifecycleRegistrySubscriptions('garbage')).toEqual([]);
    expect(lifecycleRegistrySubscriptions(undefined)).toEqual([]);
  });

  it('keeps for retention the runs still owed and the registry runs', () => {
    expect(retentionKeeps([LIFECYCLE_REGISTRY_TAG])).toBe(true);
    expect(retentionKeeps(['etl', LIFECYCLE_PENDING_TAG])).toBe(true);
    expect(retentionKeeps(['etl'])).toBe(false);
    expect(retentionKeeps(undefined)).toBe(false);
  });

  it('deletes rows whose heartbeat stopped long ago, never its own', async () => {
    const store = new InMemoryStateStore();
    let now = 100_000_000;
    const subscriptions = [{ workflow: 'y', events: [runCompletedEvent('ingest')] }];
    // Stale long before this engine booted, recently stale, and still live.
    await store.createRun(registryRow('ancient', subscriptions, now - 24 * 60 * 60 * 1000));
    await store.createRun(registryRow('recent', subscriptions, now - LIFECYCLE_REGISTRY_TTL_MS));
    await store.createRun(registryRow('live', subscriptions, now - 1_000));
    const engine = new WorkflowEngine({ store, instanceId: 'me', clock: () => now });
    engine.register('x', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });

    await engine.sweepLifecycleEvents();
    expect(await store.getRun(lifecycleRegistryRunId('ancient'))).toBeNull();
    expect(await store.getRun(lifecycleRegistryRunId('recent'))).not.toBeNull();

    // `recent` stops beating; `live` and this engine keep going.
    for (let i = 0; i < 70; i += 1) {
      now += LIFECYCLE_REGISTRY_HEARTBEAT_MS;
      await store.updateRun(lifecycleRegistryRunId('live'), {
        createdAt: new Date(now),
        updatedAt: new Date(now),
      });
      await engine.sweepLifecycleEvents();
    }
    expect(await store.getRun(lifecycleRegistryRunId('recent'))).toBeNull();
    expect(await store.getRun(lifecycleRegistryRunId('live'))).not.toBeNull();
    expect(await store.getRun(lifecycleRegistryRunId('me'))).not.toBeNull();
    expect(now - (100_000_000 - LIFECYCLE_REGISTRY_TTL_MS)).toBeGreaterThan(
      LIFECYCLE_REGISTRY_STALE_MS,
    );
  });

  it('is never pruned by retention, which still prunes the runs around it', async () => {
    const store = new InMemoryStateStore();
    let now = 50_000_000;
    const engine = new WorkflowEngine({
      store,
      instanceId: 'me',
      clock: () => now,
      retention: { completed: 1 },
      retentionPolicies: [
        { scope: { namespace: 'default' }, statuses: ['completed'], maxCount: 0 },
      ],
    });
    engine.register('x', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await engine.sweepLifecycleEvents();
    await store.createRun({
      ...registryRow('ignored', [], now),
      id: 'done',
      workflow: 'ingest',
      input: {},
      tags: [],
    });

    now += 120_000;
    expect(await engine.sweepRetention(now)).toBe(1);
    expect(await store.getRun('done')).toBeNull();
    expect((await store.getRun(lifecycleRegistryRunId('me')))?.tags).toEqual([
      LIFECYCLE_REGISTRY_TAG,
    ]);
  });

  it("does not count registry runs toward a retention policy's maxCount", async () => {
    const store = new InMemoryStateStore();
    let now = 70_000_000;
    const engine = new WorkflowEngine({ store, instanceId: 'me', clock: () => now });
    // Two settled runs, then the registry run, the newest of all.
    for (const [id, at] of [
      ['older', now - 2_000],
      ['newer', now - 1_000],
    ] as const) {
      await store.createRun({
        ...registryRow('ignored', [], at),
        id,
        workflow: 'ingest',
        input: {},
        tags: [],
      });
    }
    engine.register('x', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await engine.sweepLifecycleEvents();

    const scoped = new WorkflowEngine({
      store,
      clock: () => now,
      retentionPolicies: [
        { scope: { namespace: 'default' }, statuses: ['completed'], maxCount: 1 },
      ],
    });
    now += 1_000;
    expect(await scoped.sweepRetention(now)).toBe(1);
    expect(await store.getRun('older')).toBeNull();
    expect(await store.getRun('newer')).not.toBeNull();
    expect(await store.getRun(lifecycleRegistryRunId('me'))).not.toBeNull();
  });

  it('is hidden from run lists, counts and pickers unless asked for by name', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('x', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await engine.sweepLifecycleEvents();
    await engine.start('ingest', {}, 'i1');
    await engine.waitForRun('i1');
    await engine.waitForRun(lifecycleRunId('i1', 'completed', 'x'));

    const everything: RunQuery = {};
    const workflows = (await engine.listRuns(everything)).map((r) => r.workflow).sort();
    expect(workflows).toEqual(['ingest', 'x']);
    expect(await engine.countRuns(everything)).toBe(2);
    expect(
      (await engine.runValueFacets({ field: 'workflow' }, everything))
        .map((row) => row.value)
        .sort(),
    ).toEqual(['ingest', 'x']);
    expect((await engine.runFacets(everything)).reduce((sum, row) => sum + row.count, 0)).toBe(2);
    expect(await engine.listRuns({ workflow: LIFECYCLE_REGISTRY_WORKFLOW })).toHaveLength(1);

    const deps = { engine: storeDashboardEngine(engine) };
    const page = await listRunsHandler(deps, { params: {}, query: {} });
    expect(
      (page.body as { runs: { workflow: string }[] }).runs.map((r) => r.workflow).sort(),
    ).toEqual(['ingest', 'x']);
    const picker = await runValues(deps, { params: {}, query: { field: 'workflow' } });
    expect((picker.body as { value: string }[]).map((r) => r.value).sort()).toEqual([
      'ingest',
      'x',
    ]);
  });

  it('leaves a subscriber a registry row announces to that engine, even when reachable here', async () => {
    const store = new InMemoryStateStore();
    // `notify` is served by convention here (a live group of that name), and registered with its
    // `where`/`input` on engine `b`, which owns delivering it.
    await store.createRun(
      registryRow('b', [{ workflow: 'notify', events: [runCompletedEvent('ingest')] }], Date.now()),
    );
    const engine = new WorkflowEngine({
      store,
      transport: new DescriptorTransport([], ['notify']),
    });
    engine.register('ingest', '1', async () => 'ok');
    await engine.sweepLifecycleEvents();

    await engine.start('ingest', {}, 'i1');
    await poll(async () => (await store.getRun('i1'))?.status === 'completed');
    await settle();
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('notify')]);
    await engine.sweepLifecycleEvents(Date.now() + 60_000);
    await settle();
    expect(await store.getRun(lifecycleRunId('i1', 'completed', 'notify'))).toBeNull();
  });

  it('drops no owed subscriber while the registry cannot be read', async () => {
    const store = new InMemoryStateStore();
    const listRuns = store.listRuns.bind(store);
    let fail = true;
    store.listRuns = async (query: RunQuery) => {
      if (fail && query.workflow === LIFECYCLE_REGISTRY_WORKFLOW) throw new Error('db down');
      return listRuns(query);
    };
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      tags: [LIFECYCLE_PENDING_TAG, owed('elsewhere')],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const engine = new WorkflowEngine({ store });
    await engine.sweepLifecycleEvents(Number.MAX_SAFE_INTEGER / 2);
    expect((await store.getRun('i1'))?.tags).toEqual([LIFECYCLE_PENDING_TAG, owed('elsewhere')]);

    fail = false;
    const fresh = new WorkflowEngine({ store });
    await fresh.sweepLifecycleEvents(Number.MAX_SAFE_INTEGER / 2);
    expect((await store.getRun('i1'))?.tags).toEqual(['durable:trigger_failed:elsewhere']);
  });
});

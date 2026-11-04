import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { EngineEvent, WorkflowRun } from '../../src/interfaces.js';
import {
  LIFECYCLE_ORPHAN_MS,
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  type LifecycleRegistryEntry,
  lifecycleRegistryNamespace,
  lifecycleRegistryRunId,
  lifecycleRunId,
  runCompletedEvent,
} from '../../src/lifecycle-events.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

const owed = (subscriber: string) => `${LIFECYCLE_OWED_TAG_PREFIX}${subscriber}`;

/**
 * A live registry row of engine `instanceId` subscribing `workflow` to `ingest`'s completion.
 * `engineNamespace` is left out of the entry when `undefined`, as a row written before the field.
 */
async function announce(
  store: InMemoryStateStore,
  instanceId: string,
  workflow: string,
  opts: { rowNamespace?: string; engineNamespace?: string | null },
): Promise<void> {
  const input: Omit<LifecycleRegistryEntry, 'engineNamespace'> & {
    engineNamespace?: string | null;
  } = {
    instanceId,
    runtime: 'node',
    ...(opts.engineNamespace !== undefined ? { engineNamespace: opts.engineNamespace } : {}),
    subscriptions: [{ workflow, events: [runCompletedEvent('ingest')] }],
  };
  await store.createRun({
    id: lifecycleRegistryRunId(instanceId),
    workflow: LIFECYCLE_REGISTRY_WORKFLOW,
    workflowVersion: '1',
    status: 'completed',
    ...(opts.rowNamespace !== undefined ? { namespace: opts.rowNamespace } : {}),
    input,
    tags: [LIFECYCLE_REGISTRY_TAG],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** An engine with no namespace that runs `ingest`, its fleet snapshot read once. */
async function operatorEngine(store: InMemoryStateStore): Promise<WorkflowEngine> {
  const engine = new WorkflowEngine({ store, instanceId: 'operator' });
  engine.register('ingest', '1', async () => 'ok');
  await engine.sweepLifecycleEvents();
  return engine;
}

async function settledTags(store: InMemoryStateStore, runId: string): Promise<string[]> {
  await poll(async () => (await store.getRun(runId))?.status === 'completed');
  return [...((await store.getRun(runId))?.tags ?? [])].sort();
}

describe('lifecycle events across namespaces', () => {
  it('does not owe a tenant run settled by an engine with no namespace to another tenant’s subscriber', async () => {
    const store = new InMemoryStateStore();
    await announce(store, 'acme-1', 'notify-acme', {
      rowNamespace: 'acme',
      engineNamespace: 'acme',
    });
    await announce(store, 'evil-1', 'notify-evil', {
      rowNamespace: 'evil',
      engineNamespace: 'evil',
    });
    const operator = await operatorEngine(store);

    await operator.start('ingest', {}, 'r1', { namespace: 'acme' });

    expect(await settledTags(store, 'r1')).toEqual(
      [LIFECYCLE_PENDING_TAG, owed('notify-acme')].sort(),
    );
    expect(operator.lifecycleSubscribers('ingest', 'completed', 'acme')).toEqual(['notify-acme']);
    expect(operator.lifecycleSubscribers('ingest', 'completed', 'evil')).toEqual(['notify-evil']);
    expect(operator.lifecycleSubscribers('ingest', 'completed', 'default')).toEqual([]);
    expect(operator.lifecycleSubscribers('ingest', 'completed')).toEqual([
      'notify-acme',
      'notify-evil',
    ]);
  });

  it('owes a tenant run to the subscribers of an engine in the default namespace only for default runs', async () => {
    const store = new InMemoryStateStore();
    await announce(store, 'dflt-1', 'notify-default', {
      rowNamespace: 'default',
      engineNamespace: 'default',
    });
    const operator = await operatorEngine(store);

    await operator.start('ingest', {}, 'tenant-run', { namespace: 'acme' });
    await operator.start('ingest', {}, 'default-run');

    expect(await settledTags(store, 'tenant-run')).toEqual([]);
    expect(await settledTags(store, 'default-run')).toEqual(
      [LIFECYCLE_PENDING_TAG, owed('notify-default')].sort(),
    );
  });

  it('drops, past the orphan window, a tenant run’s owed tag for another tenant’s subscriber', async () => {
    const store = new InMemoryStateStore();
    await announce(store, 'evil-1', 'notify-evil', {
      rowNamespace: 'evil',
      engineNamespace: 'evil',
    });
    const operator = await operatorEngine(store);
    const settledAt = Date.now() - LIFECYCLE_ORPHAN_MS - 60_000;
    const run: WorkflowRun = {
      id: 'stuck',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      namespace: 'acme',
      input: {},
      output: 'ok',
      tags: [LIFECYCLE_PENDING_TAG, owed('notify-evil')],
      createdAt: new Date(settledAt),
      updatedAt: new Date(settledAt),
    };
    await store.createRun(run);
    const failed: EngineEvent[] = [];
    operator.subscribe((e) => {
      if (e.type === 'run.trigger_failed') failed.push(e);
    });

    await operator.sweepLifecycleEvents();

    expect((await store.getRun('stuck'))?.tags).toEqual(['durable:trigger_failed:notify-evil']);
    expect(failed.map((e) => [e.runId, e.name, e.error?.message])).toEqual([
      ['stuck', 'notify-evil', 'subscriber notify-evil is not registered on any live worker'],
    ]);
  });

  describe('an engine with no namespace', () => {
    it('starts its own subscribers for a tenant’s runs', async () => {
      const store = new InMemoryStateStore();
      const operator = await operatorEngine(store);
      operator.register('audit', '1', async () => 'audited', {
        onEvent: [runCompletedEvent('ingest')],
      });

      await operator.start('ingest', {}, 'r1', { namespace: 'acme' });

      const auditRun = lifecycleRunId('r1', 'completed', 'audit');
      await poll(async () => (await store.getRun(auditRun))?.status === 'completed');
      await poll(async () =>
        Boolean((await store.getRun('r1'))?.tags?.includes('durable:triggered:audit')),
      );
      expect((await store.getRun('r1'))?.tags).toEqual(['durable:triggered:audit']);
    });

    it('owes a tenant run to the subscribers another engine with no namespace announces', async () => {
      const store = new InMemoryStateStore();
      await announce(store, 'other', 'y', { engineNamespace: null });
      await announce(store, 'legacy', 'z', {});
      const operator = await operatorEngine(store);

      await operator.start('ingest', {}, 'r1', { namespace: 'acme' });

      expect(await settledTags(store, 'r1')).toEqual(
        [LIFECYCLE_PENDING_TAG, owed('y'), owed('z')].sort(),
      );
    });

    it('is seen by a tenant engine, which owes the tenant’s runs to its subscribers', async () => {
      const store = new InMemoryStateStore();
      await announce(store, 'operator-b', 'audit', { engineNamespace: null });
      const tenant = new WorkflowEngine({ store, instanceId: 'acme-1', namespace: 'acme' });
      tenant.register('ingest', '1', async () => 'ok');
      await tenant.sweepLifecycleEvents();

      await tenant.start('ingest', {}, 'r1');

      expect(await settledTags(store, 'r1')).toEqual([LIFECYCLE_PENDING_TAG, owed('audit')].sort());
    });

    it('writes engineNamespace null in its registry row, and an engine with one writes it', async () => {
      const store = new InMemoryStateStore();
      const none = new WorkflowEngine({ store, instanceId: 'none' });
      const dflt = new WorkflowEngine({ store, instanceId: 'dflt', namespace: 'default' });
      const acme = new WorkflowEngine({ store, instanceId: 'acme', namespace: 'acme' });
      for (const engine of [none, dflt, acme]) {
        engine.register('audit', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
        await engine.sweepLifecycleEvents();
      }

      const entry = async (id: string) =>
        (await store.getRun(lifecycleRegistryRunId(id)))?.input as LifecycleRegistryEntry;
      expect((await entry('none')).engineNamespace).toBeNull();
      expect((await entry('dflt')).engineNamespace).toBe('default');
      expect((await entry('acme')).engineNamespace).toBe('acme');
      // The stores write the first two rows under the same namespace.
      expect((await store.getRun(lifecycleRegistryRunId('none')))?.namespace).toBe('default');
      expect((await store.getRun(lifecycleRegistryRunId('dflt')))?.namespace).toBe('default');
    });
  });

  it('reads a registry row’s namespace from engineNamespace, else from the row', () => {
    expect(lifecycleRegistryNamespace({ engineNamespace: null }, 'default')).toBeNull();
    expect(lifecycleRegistryNamespace({ engineNamespace: 'default' }, 'default')).toBe('default');
    expect(lifecycleRegistryNamespace({ engineNamespace: 'acme' }, 'acme')).toBe('acme');
    expect(lifecycleRegistryNamespace({}, 'acme')).toBe('acme');
    expect(lifecycleRegistryNamespace({}, 'default')).toBeNull();
    expect(lifecycleRegistryNamespace(undefined, undefined)).toBeNull();
  });
});

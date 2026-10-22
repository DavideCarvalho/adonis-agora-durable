import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import type { Transport, WorkerHeartbeat } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import type { BullMQDeps, RedisLike } from '../../src/transports/bullmq/deps.js';

/** `StartOptions.version`, `engine.remote()`, `workflowDirectory()` / `announcedWorkflows()` and the
 *  fleet-wide reads (`readAllWorkerDescriptors` / `readAllWorkerHeartbeats`) behind them. */

describe('StartOptions.version', () => {
  function engine() {
    const e = new WorkflowEngine({ store: new InMemoryStateStore() });
    e.register('w', '1', async () => 'one');
    e.register('w', '2', async () => 'two');
    return e;
  }

  it('pins the run to the registered version; absent takes the newest', async () => {
    const e = engine();
    await e.start('w', {}, 'pinned', { version: '1' });
    await e.start('w', {}, 'newest');
    expect((await e.waitForRun('pinned')).output).toBe('one');
    expect((await e.getRun('pinned'))?.workflowVersion).toBe('1');
    expect((await e.waitForRun('newest')).output).toBe('two');
  });

  it('an unregistered version throws before a run row exists, never falling back', async () => {
    const e = engine();
    await expect(e.start('w', {}, 'r3', { version: '3' })).rejects.toThrow(
      'workflow w@3 is not registered',
    );
    expect(await e.getRun('r3')).toBeNull();
  });
});

describe('engine.remote()', () => {
  it('registers a remote workflow at a version, routed over the primary transport', async () => {
    const dispatched: Array<{ workflow: string; group: string }> = [];
    const transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
      dispatchWorkflowTask: async (task: { workflow: string; group: string }) => {
        dispatched.push({ workflow: task.workflow, group: task.group });
      },
      onDecision: () => {},
    } as unknown as Transport;
    const e = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    e.remote('py.report', { group: 'reports', version: '2' });

    await e.start('py.report', {}, 'r1', { version: '2' });
    await new Promise((r) => setTimeout(r, 20));
    expect((await e.getRun('r1'))?.workflowVersion).toBe('2');
    expect(dispatched).toEqual([{ workflow: 'py.report', group: 'reports' }]);
    await expect(e.start('py.report', {}, 'r2', { version: '1' })).rejects.toThrow(
      'py.report@1 is not registered',
    );
  });

  it('throws without a transport to route over', () => {
    const e = new WorkflowEngine({ store: new InMemoryStateStore() });
    expect(() => e.remote('x', { group: 'g' })).toThrow(/needs a transport/);
  });
});

function descriptor(over: Partial<WorkerDescriptor>): WorkerDescriptor {
  return {
    instanceId: 'w1',
    runtime: 'python',
    sdk: { name: 'durable-py', version: '1.0.0' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [],
    steps: [],
    startedAt: 1,
    ...over,
  };
}

function fleetTransport(descriptors: WorkerDescriptor[], beats: WorkerHeartbeat[]): Transport {
  return {
    dispatch: async () => {},
    onResult: () => {},
    onHeartbeat: () => {},
    readAllWorkerDescriptors: async () => descriptors,
    readAllWorkerHeartbeats: async () => beats,
  } as unknown as Transport;
}

describe('workflowDirectory() / announcedWorkflows()', () => {
  it('says the fleet could not be asked when no transport can read it', async () => {
    const e = new WorkflowEngine({ store: new InMemoryStateStore() });
    const dir = await e.workflowDirectory();
    expect(dir.supported).toBe(false);
    expect(dir.workflows).toEqual([]);
    expect(dir.detail).toMatch(/nothing here was asked/);
  });

  it('folds declared workflows, observed queues and other partitions', async () => {
    const beat = (group: string, instanceId: string): WorkerHeartbeat => ({
      group,
      instanceId,
      lastBeatAt: Date.now(),
    });
    const e = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: fleetTransport(
        [
          descriptor({
            instanceId: 'py-1',
            workflows: ['report'],
            steps: ['render'],
            namespace: 'acme',
            partition: 'acme',
            registrations: [{ name: 'report', version: '2', group: 'report@acme' }],
          }),
        ],
        [
          beat('report@acme', 'py-1'),
          beat('render@acme', 'py-1'), // a declared step queue: not a workflow
          beat('legacy@acme', 'old-1'), // no descriptor: observed
          beat('billing@globex', 'g-1'), // another partition
        ],
      ),
      namespace: 'acme',
    });

    const dir = await e.workflowDirectory();
    expect(dir.supported).toBe(true);
    expect(dir.workflows.map((w) => [w.key, w.evidence])).toEqual([
      ['legacy@acme', 'observed'],
      ['report@2', 'declared'],
    ]);
    expect(dir.otherPartitions).toEqual([
      { partition: 'globex', groups: ['billing@globex'], instances: ['g-1'] },
    ]);
    expect(await e.announcedWorkflows()).toEqual(dir.workflows);
  });
});

describe('BullMQTransport fleet-wide reads', () => {
  function redisWith(entries: Record<string, string>): RedisLike {
    return {
      publish: async () => 1,
      subscribe: async () => 1,
      on: () => undefined,
      set: async () => 'OK',
      scan: async (_cursor, ...args) => {
        const pattern = String(args[1]);
        const prefix = pattern.slice(0, -1);
        return ['0', Object.keys(entries).filter((k) => k.startsWith(prefix))];
      },
      get: async (k) => entries[k] ?? null,
      mget: async (...keys) => keys.map((k) => entries[k] ?? null),
      disconnect: () => undefined,
    };
  }

  it('reads every descriptor and every heartbeat across tokens', async () => {
    const d = descriptor({ instanceId: 'py-1', workflows: ['report'] });
    const redis = redisWith({
      'durable-worker-descriptor:report:py-1': JSON.stringify(d),
      'durable-worker-descriptor:other:py-2': '{not json',
      'durable-worker-heartbeat:report:py-1': JSON.stringify({ ts: 1_700_000_000_000 }),
      'durable-worker-heartbeat:render@acme:py-2': '1700000000',
    });
    const deps = {
      makeQueue: () => ({}) as never,
      makeWorker: () => ({}) as never,
      makeRedis: () => redis,
    } as unknown as BullMQDeps;
    const t = new BullMQTransport({ deps, pingIntervalMs: false });

    expect(await t.readAllWorkerDescriptors()).toEqual([d]);
    const beats = await t.readAllWorkerHeartbeats();
    expect(beats).toEqual(
      expect.arrayContaining([
        { group: 'report', instanceId: 'py-1', lastBeatAt: 1_700_000_000_000 },
        { group: 'render@acme', instanceId: 'py-2', lastBeatAt: 1_700_000_000_000 },
      ]),
    );
  });

  it('degrades to [] and reports through onError when the keyspace cannot be read', async () => {
    const errors: unknown[] = [];
    const redis = {
      scan: async () => {
        throw new Error('NOPERM');
      },
      disconnect: () => undefined,
    } as unknown as RedisLike;
    const t = new BullMQTransport({
      deps: { makeRedis: () => redis } as unknown as BullMQDeps,
      onError: (e) => errors.push(e),
      pingIntervalMs: false,
    });
    expect(await t.readAllWorkerDescriptors()).toEqual([]);
    expect(await t.readAllWorkerHeartbeats()).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});

import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import DurableProvider from '../providers/durable_provider.js';
import type { DurableConfig } from '../src/define_config.js';
import { type RunDispatch, type StateStore, WorkflowEngine } from '../src/index.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../src/testing/in-memory-transport.js';

/**
 * The provider leaves where runs execute to the transport: on a driving instance (standalone, no
 * `drive: false`) an engine whose transport has a run queue consumes it and sends its runs through
 * it; a process that must not drive runs never consumes it; shutdown stops the consumer before the
 * transport closes.
 */
class RunQueueTransport extends InMemoryTransport {
  readonly dispatched: RunDispatch[] = [];
  handler: ((runId: string) => Promise<void>) | undefined;
  consumerConcurrency: number | undefined;
  stopped = 0;
  closedAfterStop: boolean | undefined;

  async dispatchRuns(runs: readonly RunDispatch[]): Promise<void> {
    this.dispatched.push(...runs);
    for (const run of runs) setImmediate(() => void this.handler?.(run.runId));
  }

  onDispatchedRun(
    handler: (runId: string) => Promise<void>,
    opts: { concurrency: number; namespace?: string | undefined },
  ): () => Promise<void> {
    this.handler = handler;
    this.consumerConcurrency = opts.concurrency;
    return async () => {
      this.stopped += 1;
      this.handler = undefined;
    };
  }

  async close(): Promise<void> {
    this.closedAfterStop = this.stopped > 0;
  }
}

function fakeApp(config: DurableConfig) {
  let factory: (() => unknown) | undefined;
  let singleton: unknown;
  const app = {
    config: { get: (key: string, fallback?: unknown) => (key === 'durable' ? config : fallback) },
    getEnvironment: () => 'web',
    makePath: (...parts: string[]) => ['/app', ...parts].join('/'),
    container: {
      singleton: (_key: unknown, f: () => unknown) => {
        factory = f;
      },
      make: async (key: unknown) => {
        if (key === WorkflowEngine) {
          if (!singleton) singleton = await factory?.();
          return singleton as WorkflowEngine;
        }
        const Ctor = key as new () => unknown;
        return new Ctor();
      },
    },
  } as unknown as ApplicationService;
  const provider = new DurableProvider(app);
  provider.register();
  return {
    provider,
    resolve: async () => (await app.container.make(WorkflowEngine)) as WorkflowEngine,
  };
}

const config = (
  store: StateStore,
  transport: RunQueueTransport,
  extra: Partial<DurableConfig> = {},
): DurableConfig =>
  ({
    store: 'mem',
    stores: { mem: async () => store },
    transport: 'q',
    transports: { q: async () => transport },
    workflowsPath: false,
    stepsPath: false,
    ...extra,
  }) as DurableConfig;

async function until(check: () => Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

describe('DurableProvider and the transport run queue', () => {
  it('a standalone (driving) instance consumes the run queue and starts runs through it', async () => {
    const store = new InMemoryStateStore();
    const transport = new RunQueueTransport();
    const { provider, resolve } = fakeApp(config(store, transport));
    const engine = await resolve();
    expect(transport.handler).toBeTypeOf('function');
    expect(transport.consumerConcurrency).toBeGreaterThan(0);
    engine.register('echo', '1', async (_ctx, input) => input);
    await engine.start('echo', 'hi', 'r1');
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(transport.dispatched).toEqual([
      { runId: 'r1', reason: 'start', key: expect.any(String) },
    ]);
    await provider.shutdown();
    // The consumer stopped before the transport closed.
    expect(transport.stopped).toBe(1);
    expect(transport.closedAfterStop).toBe(true);
  });

  it('a drive: false instance never consumes the run queue nor runs anything', async () => {
    const store = new InMemoryStateStore();
    const transport = new RunQueueTransport();
    const { provider, resolve } = fakeApp(config(store, transport, { drive: false }));
    const engine = await resolve();
    expect(transport.handler).toBeUndefined();
    engine.register('echo', '1', async (_ctx, input) => input);
    await engine.start('echo', 'hi', 'r1');
    await new Promise((r) => setTimeout(r, 50));
    expect((await store.getRun('r1'))?.status).toBe('pending');
    expect(transport.dispatched).toEqual([]);
    await provider.shutdown();
  });

  it('a control plane never consumes the run queue', async () => {
    const transport = new RunQueueTransport();
    const { provider, resolve } = fakeApp(
      config(new InMemoryStateStore(), transport, { role: 'control-plane' }),
    );
    await resolve();
    expect(transport.handler).toBeUndefined();
    await provider.shutdown();
  });
});

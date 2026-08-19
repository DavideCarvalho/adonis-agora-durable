import { describe, expect, it, vi } from 'vitest';
import { transports } from '../../../src/transports/factory.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/** A fake booted app exposing only `config.get('queue', …)` — what the factory reads. */
function fakeCtx(queueConfig: unknown) {
  const ctx = {
    app: {
      container: {
        make: async () => {
          throw new Error('not used');
        },
      },
      config: {
        get: (key: string, fallback?: unknown) => (key === 'queue' ? queueConfig : fallback),
      },
    },
  };
  // structural test double for TransportContext
  return ctx as any;
}

describe('transports.queue — connection resolution from config/queue.ts', () => {
  it('resolves a raw adapter-factory entry by connection name', async () => {
    const ctx = fakeCtx({ default: 'redis', adapters: { redis: () => new MockAdapter() } });
    const transport = await transports.queue({ connection: 'redis' })(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('uses the default connection when none is given', async () => {
    const ctx = fakeCtx({ default: 'redis', adapters: { redis: () => new MockAdapter() } });
    const transport = await transports.queue()(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('resolves a config-provider entry via resolver(app)', async () => {
    const ctx = fakeCtx({ adapters: { redis: { resolver: () => () => new MockAdapter() } } });
    const transport = await transports.queue({ connection: 'redis' })(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('lets an explicit adapter override take precedence over connection', async () => {
    const ctx = fakeCtx({ adapters: {} }); // no connections configured
    const transport = await transports.queue({ adapter: () => new MockAdapter() })(ctx);
    expect(transport).toBeTruthy();
    await transport.close?.();
  });

  it('throws on an unknown connection name', async () => {
    const ctx = fakeCtx({ default: 'redis', adapters: { redis: () => new MockAdapter() } });
    await expect(transports.queue({ connection: 'nope' })(ctx)).rejects.toThrow(
      /unknown @adonisjs\/queue connection "nope"/,
    );
  });

  it('throws when no connection is given and config/queue.ts has no default', async () => {
    const ctx = fakeCtx({ adapters: {} });
    await expect(transports.queue()(ctx)).rejects.toThrow(/needs a `connection`/);
  });
});

describe('transports.queue — options reaching the transport', () => {
  it('folds `namespace` into every queue name', async () => {
    const adapter = new MockAdapter();
    const ctx = fakeCtx({ adapters: {} });
    const transport = await transports.queue({ adapter: () => adapter, namespace: 'edge' })(ctx);
    await transport.dispatch({
      taskId: 't1',
      runId: 'r1',
      stepId: 's1',
      name: 'ship',
      group: 'ship',
      input: {},
      attempt: 1,
    } as never);
    expect([...adapter.pending.keys()]).toEqual(['durable-edge:tasks:ship']);
    await transport.close?.();
  });

  it('subscribes a handler on its `<name>@<partition>` routing token', async () => {
    const adapter = new MockAdapter();
    const ctx = fakeCtx({ adapters: {} });
    const transport = await transports.queue({ adapter: () => adapter, partition: 'acme' })(ctx);
    // A partitioned worker claims the partition-suffixed token, so a dispatch addressed to the bare
    // name is NOT stolen from another pool.
    (transport as unknown as { handle(name: string, fn: unknown): void }).handle(
      'ship',
      async () => 'ok',
    );
    await transport.dispatch({
      taskId: 't1',
      runId: 'r1',
      stepId: 's1',
      name: 'ship',
      group: 'ship@acme',
      input: {},
      attempt: 1,
    } as never);
    expect([...adapter.pending.keys()]).toEqual(['durable:tasks:ship@acme']);
    await transport.close?.();
  });

  it('routes poll-loop failures to the supplied `onError`', async () => {
    const errors: unknown[] = [];
    const adapter = new MockAdapter();
    const ctx = fakeCtx({ adapters: {} });
    const transport = await transports.queue({
      adapter: () => adapter,
      onError: (err) => errors.push(err),
      pollIntervalMs: 1,
    })(ctx);
    transport.onResult(async () => {
      throw new Error('boom');
    });
    await adapter.pushOn('durable:results', {
      id: 'j1',
      name: 'result',
      payload: '{}',
      attempts: 0,
      createdAt: Date.now(),
    });
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect((errors[0] as Error).message).toBe('boom');
    await transport.close?.();
  });

  it('passes the stalled-reclaim knobs into the sweep', async () => {
    const sweeps: [string, number, number][] = [];
    const adapter = new MockAdapter();
    adapter.recoverStalledJobs = async (queue, thresholdMs, maxStalledCount) => {
      sweeps.push([queue, thresholdMs, maxStalledCount]);
      return 0;
    };
    const ctx = fakeCtx({ adapters: {} });
    const transport = await transports.queue({
      adapter: () => adapter,
      pollIntervalMs: 1,
      stalledCheckIntervalMs: 1,
      stalledThresholdMs: 60_000,
      maxStalledCount: 7,
    })(ctx);
    transport.onResult(async () => {});
    await vi.waitFor(() => expect(sweeps.length).toBeGreaterThan(0));
    expect(sweeps[0]).toEqual(['durable:results', 60_000, 7]);
    await transport.close?.();
  });

  it('`stalledCheckIntervalMs: 0` disables the sweep entirely', async () => {
    let swept = 0;
    const adapter = new MockAdapter();
    adapter.recoverStalledJobs = async () => {
      swept += 1;
      return 0;
    };
    const ctx = fakeCtx({ adapters: {} });
    const transport = await transports.queue({
      adapter: () => adapter,
      pollIntervalMs: 1,
      stalledCheckIntervalMs: 0,
    })(ctx);
    transport.onResult(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(swept).toBe(0);
    await transport.close?.();
  });
});

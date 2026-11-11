import type {
  DeliveredEvent,
  DeliveryTransportContext,
  ListenerDelivery,
  ListenerInvoker,
} from '@adonis-agora/diagnostics/delivery';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import durableDiagnostics, {
  createDeliveryTransport,
  DIAGNOSTICS_LISTENER_ORIGIN,
  DIAGNOSTICS_LISTENER_WORKFLOW,
  diagnosticsRunId,
  isConfigured,
} from '../../src/diagnostics/index.js';
import { stopDiagnosticsDeliveries } from '../../src/diagnostics/transport.js';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import { WorkflowEngine } from '../../src/engine.js';
import { RunAlreadyExistsError } from '../../src/errors.js';
import type { EngineEvent, WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A minimal app whose container binds `engine` (or nothing). */
function fakeApp(engine?: WorkflowEngine): ApplicationService {
  return {
    container: {
      hasBinding: (binding: unknown) => engine !== undefined && binding === WorkflowEngine,
      make: async (binding: unknown) => {
        if (engine && binding === WorkflowEngine) return engine;
        throw new Error(`no binding for ${String(binding)}`);
      },
    },
  } as unknown as ApplicationService;
}

function setup(invoke: ListenerInvoker) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const context: DeliveryTransportContext = {
    app: fakeApp(engine),
    nodeId: 'web-1',
    invoke,
    listenerIds: ['app/listeners/diagnostics/track_run#handle'],
  };
  return { store, engine, context };
}

let seq = 0;
function delivery(
  overrides: Partial<DeliveredEvent> = {},
  listenerId = 'app/listeners/diagnostics/track_run#handle',
): ListenerDelivery {
  seq += 1;
  return {
    listenerId,
    envelope: {
      v: 1,
      id: `evt-${seq}`,
      ts: 1_700_000_000_000,
      lib: 'agent',
      event: 'run.finished',
      traceId: undefined,
      payload: { runId: `r${seq}` },
      ...overrides,
    },
  };
}

async function settled(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 400; i += 1) {
    const run = await store.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled', 'dead'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not settle`);
}

const engines: WorkflowEngine[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) await stopDiagnosticsDeliveries(engine);
});

describe('@adonis-agora/durable/diagnostics', () => {
  it('is the module transports.durable() expects', () => {
    expect(typeof durableDiagnostics.isConfigured).toBe('function');
    expect(typeof durableDiagnostics.createDeliveryTransport).toBe('function');
    expect(durableDiagnostics.isConfigured).toBe(isConfigured);
  });

  it('isConfigured: true only when an engine is bound in the container', () => {
    expect(isConfigured(fakeApp(new WorkflowEngine({ store: new InMemoryStateStore() })))).toBe(
      true,
    );
    expect(isConfigured(fakeApp())).toBe(false);
    expect(isConfigured({ container: {} } as unknown as ApplicationService)).toBe(false);
  });

  it('registers the listener workflow on the app engine', async () => {
    const { engine, context } = setup(async () => {});
    engines.push(engine);
    await createDeliveryTransport(context, {});
    await expect(
      engine.start(DIAGNOSTICS_LISTENER_WORKFLOW, delivery(), 'probe'),
    ).resolves.toBeDefined();
  });

  it('deliver: one run per delivery, which calls the listener with the event', async () => {
    const invoke = vi.fn<ListenerInvoker>(async () => {});
    const { store, engine, context } = setup(invoke);
    engines.push(engine);
    const transport = await createDeliveryTransport(context, {});
    const a = delivery();
    const b = delivery({}, 'Audit#handle');

    await transport.deliver([a, b]);

    const runA = await settled(store, diagnosticsRunId(a.envelope.id, a.listenerId));
    const runB = await settled(store, diagnosticsRunId(b.envelope.id, b.listenerId));
    expect(runA.id).toBe(`diag:${a.envelope.id}:app/listeners/diagnostics/track_run#handle`);
    expect(runA).toMatchObject({
      status: 'completed',
      workflow: DIAGNOSTICS_LISTENER_WORKFLOW,
      origin: DIAGNOSTICS_LISTENER_ORIGIN,
      input: { listenerId: a.listenerId, envelope: a.envelope },
    });
    expect(runA.tags).toEqual(
      expect.arrayContaining([
        'diagnostics',
        'lib:agent',
        'event:run.finished',
        'listener:app/listeners/diagnostics/track_run#handle',
      ]),
    );
    expect(runB.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith(a.listenerId, a.envelope);
    expect(invoke).toHaveBeenCalledWith(b.listenerId, b.envelope);
    const [step] = await store.listCheckpoints(runA.id);
    expect(step).toMatchObject({ name: 'handle', status: 'completed', attempts: 1 });
  });

  it('retries the handle step when the listener throws, then succeeds', async () => {
    let calls = 0;
    const invoke = vi.fn<ListenerInvoker>(async () => {
      calls += 1;
      if (calls < 3) throw new Error(`attempt ${calls} fails`);
    });
    const { store, engine, context } = setup(invoke);
    engines.push(engine);
    const transport = await createDeliveryTransport(context, { retries: 3, backoffMs: 1 });
    const d = delivery();

    await transport.deliver([d]);

    const run = await settled(store, diagnosticsRunId(d.envelope.id, d.listenerId));
    expect(run.status).toBe('completed');
    expect(invoke).toHaveBeenCalledTimes(3);
    const [step] = await store.listCheckpoints(run.id);
    expect(step).toMatchObject({ name: 'handle', status: 'completed', attempts: 3 });
  });

  it('fails the run once the retries are spent, with the listener error', async () => {
    const invoke = vi.fn<ListenerInvoker>(async () => {
      throw new Error('listener broke');
    });
    const { store, engine, context } = setup(invoke);
    engines.push(engine);
    const transport = await createDeliveryTransport(context, { retries: 2, backoffMs: 0 });
    const d = delivery();

    await transport.deliver([d]);

    const run = await settled(store, diagnosticsRunId(d.envelope.id, d.listenerId));
    expect(run.status).toBe('failed');
    expect(run.error?.message).toContain('listener broke');
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('defaults to three attempts', async () => {
    const invoke = vi.fn<ListenerInvoker>(async () => {
      throw new Error('always');
    });
    const { store, engine, context } = setup(invoke);
    engines.push(engine);
    // backoffMs 0 keeps the test fast; the attempt count is the default's.
    const transport = await createDeliveryTransport(context, { backoffMs: 0 });
    const d = delivery();
    await transport.deliver([d]);
    await settled(store, diagnosticsRunId(d.envelope.id, d.listenerId));
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it('an unknown listener fails the run at once, without retrying', async () => {
    const invoke = vi.fn<ListenerInvoker>(async (listenerId) => {
      throw Object.assign(new Error(`no listener "${listenerId}" is registered in this process`), {
        code: 'E_UNKNOWN_DIAGNOSTICS_LISTENER',
      });
    });
    const { store, engine, context } = setup(invoke);
    engines.push(engine);
    const transport = await createDeliveryTransport(context, { retries: 5, backoffMs: 0 });
    const d = delivery({}, 'Renamed#handle');

    await transport.deliver([d]);

    const run = await settled(store, diagnosticsRunId(d.envelope.id, d.listenerId));
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'E_UNKNOWN_DIAGNOSTICS_LISTENER' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: the same delivery handed over twice is one run and one call', async () => {
    const invoke = vi.fn<ListenerInvoker>(async () => {});
    const { store, engine, context } = setup(invoke);
    engines.push(engine);
    const transport = await createDeliveryTransport(context, {});
    const d = delivery();

    await Promise.all([transport.deliver([d]), transport.deliver([d])]);
    await transport.deliver([d]);

    const runId = diagnosticsRunId(d.envelope.id, d.listenerId);
    await settled(store, runId);
    await transport.deliver([d]);
    const runs = await store.listRuns({ workflow: DIAGNOSTICS_LISTENER_WORKFLOW });
    expect(runs.map((r) => r.id)).toEqual([runId]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('counts a store-level duplicate (RunAlreadyExistsError) as delivered', async () => {
    const { engine, context } = setup(async () => {});
    engines.push(engine);
    const transport = await createDeliveryTransport(context, {});
    vi.spyOn(engine, 'start').mockRejectedValueOnce(new RunAlreadyExistsError('diag:x:y'));
    await expect(transport.deliver([delivery()])).resolves.toBeUndefined();
  });

  it('starts every delivery even when one fails, then rejects with the failure', async () => {
    const { store, engine, context } = setup(async () => {});
    engines.push(engine);
    const transport = await createDeliveryTransport(context, {});
    const bad = delivery();
    const good = delivery();
    const start = engine.start.bind(engine);
    vi.spyOn(engine, 'start').mockImplementation(((
      workflow: string,
      input: unknown,
      runId: string,
      opts?: object,
    ) => {
      if (runId.includes(bad.envelope.id)) return Promise.reject(new Error('store down'));
      return start(workflow, input, runId, opts);
    }) as typeof engine.start);

    await expect(transport.deliver([bad, good])).rejects.toThrow('store down');
    const run = await settled(store, diagnosticsRunId(good.envelope.id, good.listenerId));
    expect(run.status).toBe('completed');
  });

  it('stop() waits for the runs being created, then refuses new deliveries', async () => {
    const { engine, context } = setup(async () => {});
    engines.push(engine);
    const transport = await createDeliveryTransport(context, {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = engine.start.bind(engine);
    vi.spyOn(engine, 'start').mockImplementation((async (...args: Parameters<typeof start>) => {
      await gate;
      return start(...args);
    }) as typeof engine.start);

    const pending = transport.deliver([delivery()]);
    let stopped = false;
    const stopping = transport.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false);
    release();
    await pending;
    await stopping;
    expect(stopped).toBe(true);
    await expect(transport.deliver([delivery()])).rejects.toThrow(/stopped/);
  });

  it('stopDiagnosticsDeliveries stops the transports of that engine (the provider shutdown path)', async () => {
    const { engine, context } = setup(async () => {});
    const transport = await createDeliveryTransport(context, {});
    await stopDiagnosticsDeliveries(engine);
    await expect(transport.deliver([delivery()])).rejects.toThrow(/stopped/);
  });

  it('rejects an invalid transports.durable() config at boot', async () => {
    const { context } = setup(async () => {});
    await expect(createDeliveryTransport(context, { retries: 0 })).rejects.toThrow(/retries/);
    await expect(createDeliveryTransport(context, { retries: 1.5 })).rejects.toThrow(/retries/);
    await expect(createDeliveryTransport(context, { backoffMs: -1 })).rejects.toThrow(/backoffMs/);
    await expect(createDeliveryTransport(context, { backoff: 'linear' as 'exp' })).rejects.toThrow(
      /backoff/,
    );
  });

  it('does not echo delivery runs onto the diagnostics bus (no listener feedback loop)', async () => {
    const emitted: Array<{ event: string; runId: string }> = [];
    const slot = Symbol.for('@agora/diagnostics:emit');
    const g = globalThis as Record<symbol, unknown>;
    const previous = g[slot];
    g[slot] = (_lib: string, event: string, payload: EngineEvent) =>
      emitted.push({ event, runId: payload.runId });
    try {
      const { store, engine, context } = setup(async () => {});
      engines.push(engine);
      const detach = attachDurableDiagnostics(engine);
      engine.register('plain', '1', async () => 'ok');
      const transport = await createDeliveryTransport(context, {});
      const d = delivery();
      await transport.deliver([d]);
      await settled(store, diagnosticsRunId(d.envelope.id, d.listenerId));
      await engine.start('plain', {}, 'plain-1');
      await settled(store, 'plain-1');
      detach();
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted.every((e) => e.runId === 'plain-1')).toBe(true);
    } finally {
      g[slot] = previous;
    }
  });
});

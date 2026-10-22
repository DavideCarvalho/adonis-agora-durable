import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlMessage, Heartbeat, RemoteTask, StepResult } from '../../../src/interfaces.js';
import { EventEmitterTransport } from '../../../src/transports/event-emitter.js';

const CONTEXT_SCOPE = Symbol.for('@agora/context:scope');

const task = (over: Partial<RemoteTask> = {}): RemoteTask => ({
  runId: 'r1',
  seq: 0,
  name: 'payments.charge-card',
  stepId: 'r1:0',
  group: 'payments',
  input: { amount: 10 },
  attempt: 1,
  ...over,
});

// The transport delivers results on a later tick (so a durable ctx.step suspends first); poll.
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('EventEmitterTransport', () => {
  it('a result handler that throws is reported and the result redelivered — never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const errors: unknown[] = [];
      const transport = new EventEmitterTransport({ onError: (err) => errors.push(err) });
      transport.handle('payments.charge-card', async () => 'ok');
      let calls = 0;
      const settled: StepResult[] = [];
      transport.onResult(async (r) => {
        calls += 1;
        if (calls < 3) throw new Error('store down');
        settled.push(r);
      });
      await transport.dispatch(task());
      for (let i = 0; i < 100 && settled.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(settled).toHaveLength(1);
      expect(calls).toBe(3);
      expect(errors).toHaveLength(2);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await transport.close();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a heartbeat handler that throws is reported, not left unhandled', async () => {
    const errors: unknown[] = [];
    const transport = new EventEmitterTransport({ onError: (err) => errors.push(err) });
    transport.onHeartbeat(async () => {
      throw new Error('store down');
    });
    await transport.heartbeat({ runId: 'r1', seq: 0, stepId: 'r1:0', group: 'payments' });
    await waitFor(() => errors.length > 0);
    expect(errors).toHaveLength(1);
  });

  it('close() stops redelivering a failing result', async () => {
    const errors: unknown[] = [];
    const transport = new EventEmitterTransport({ onError: (err) => errors.push(err) });
    transport.handle('payments.charge-card', async () => 'ok');
    transport.onResult(async () => {
      throw new Error('store down');
    });
    await transport.dispatch(task());
    await waitFor(() => errors.length > 0);
    await transport.close();
    const after = errors.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(errors.length).toBeLessThanOrEqual(after + 1);
  });

  it('routes a dispatched task to a registered handler and delivers the result', async () => {
    const transport = new EventEmitterTransport();
    transport.handle('payments.charge-card', async (input) => ({
      chargeId: `ch_${(input as { amount: number }).amount}`,
    }));

    const results: StepResult[] = [];
    transport.onResult(async (r) => {
      results.push(r);
    });

    await transport.dispatch(task());
    await waitFor(() => results.length > 0);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('completed');
    expect(results[0]?.output).toEqual({ chargeId: 'ch_10' });
    expect(results[0]?.stepId).toBe('r1:0');
  });

  it('reports a failed result when the handler throws', async () => {
    const transport = new EventEmitterTransport();
    transport.handle('payments.charge-card', async () => {
      throw new Error('declined');
    });

    const results: StepResult[] = [];
    transport.onResult(async (r) => {
      results.push(r);
    });

    await transport.dispatch(task());
    await waitFor(() => results.length > 0);

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error?.message).toBe('declined');
  });

  it('stays silent when no handler owns the dispatched step name', async () => {
    const transport = new EventEmitterTransport();
    const results: StepResult[] = [];
    transport.onResult(async (r) => {
      results.push(r);
    });

    await transport.dispatch(task({ name: 'nobody.handles-this' }));
    await waitFor(() => results.length > 0);

    expect(results).toHaveLength(0);
  });

  it('delivers heartbeats to the engine onHeartbeat handler', async () => {
    const transport = new EventEmitterTransport();
    const beats: Heartbeat[] = [];
    transport.onHeartbeat(async (b) => {
      beats.push(b);
    });

    const beat: Heartbeat = { runId: 'r1', seq: 0, stepId: 'r1:0', group: 'payments' };
    await transport.heartbeat(beat);
    await waitFor(() => beats.length > 0);

    expect(beats[0]).toEqual(beat);
  });

  it('publishControl stamps `from` with the instanceId and onControl broadcasts it', async () => {
    const transport = new EventEmitterTransport({ instanceId: 'engine-A' });
    const got: ControlMessage[] = [];
    transport.onControl((msg) => got.push(msg));

    await transport.publishControl({ kind: 'cancel', runId: 'r1' });
    await waitFor(() => got.length > 0);

    expect(got[0]?.kind).toBe('cancel');
    expect(got[0]?.from).toBe('engine-A');
  });

  it('shares a passed-in emitter so two instances interoperate (engine + worker split)', async () => {
    const bus = new EventEmitter();
    const engine = new EventEmitterTransport({ emitter: bus });
    const worker = new EventEmitterTransport({ emitter: bus });

    worker.handle('payments.charge-card', async (input) => ({
      doubled: (input as { amount: number }).amount * 2,
    }));

    const results: StepResult[] = [];
    engine.onResult(async (r) => {
      results.push(r);
    });

    await engine.dispatch(task());
    await waitFor(() => results.length > 0);

    expect(results[0]?.status).toBe('completed');
    expect(results[0]?.output).toEqual({ doubled: 20 });
  });

  describe('namespace channel segmentation', () => {
    it("two namespaces over ONE shared emitter do NOT cross-process each other's tasks", async () => {
      const bus = new EventEmitter();
      const alpha = new EventEmitterTransport({ emitter: bus });
      const beta = new EventEmitterTransport({ emitter: bus });
      // The engine pushes its namespace onto the transport (before any handler registration).
      alpha.useNamespace('alpha');
      beta.useNamespace('beta');

      const alphaSeen: string[] = [];
      const betaSeen: string[] = [];
      alpha.handle('payments.charge-card', async () => {
        alphaSeen.push('alpha');
        return { from: 'alpha' };
      });
      beta.handle('payments.charge-card', async () => {
        betaSeen.push('beta'); // must NEVER run for an alpha-dispatched task
        return { from: 'beta' };
      });

      const alphaResults: StepResult[] = [];
      alpha.onResult(async (r) => {
        alphaResults.push(r);
      });

      await alpha.dispatch(task());
      await waitFor(() => alphaResults.length > 0);

      expect(alphaSeen).toEqual(['alpha']);
      expect(betaSeen).toEqual([]); // beta never saw alpha's task over the shared bus
      expect(alphaResults[0]?.output).toEqual({ from: 'alpha' });
    });

    it('a "default" namespace keeps the channels byte-identical (interops with an un-namespaced peer)', async () => {
      const bus = new EventEmitter();
      const engine = new EventEmitterTransport({ emitter: bus }); // never namespaced
      const worker = new EventEmitterTransport({ emitter: bus });
      worker.useNamespace('default'); // byte-identical channels → still interoperates

      worker.handle('payments.charge-card', async () => ({ ok: true }));
      const results: StepResult[] = [];
      engine.onResult(async (r) => {
        results.push(r);
      });

      await engine.dispatch(task());
      await waitFor(() => results.length > 0);

      expect(results[0]?.status).toBe('completed');
      expect(results[0]?.output).toEqual({ ok: true });
    });

    it('an explicit constructor namespace WINS over a later useNamespace()', async () => {
      const bus = new EventEmitter();
      const engine = new EventEmitterTransport({ emitter: bus, namespace: 'alpha' });
      engine.useNamespace('beta'); // ignored — explicit wins
      const worker = new EventEmitterTransport({ emitter: bus, namespace: 'alpha' });

      worker.handle('payments.charge-card', async () => ({ ok: true }));
      const results: StepResult[] = [];
      engine.onResult(async (r) => {
        results.push(r);
      });

      await engine.dispatch(task());
      await waitFor(() => results.length > 0);

      // engine (alpha) and worker (alpha) interoperate despite engine.useNamespace('beta').
      expect(results[0]?.output).toEqual({ ok: true });
    });
  });

  describe('context propagation', () => {
    afterEach(() => {
      delete (globalThis as Record<symbol, unknown>)[CONTEXT_SCOPE];
    });

    it('runs the handler INSIDE the restored context scope (funnels through runStepHandler)', async () => {
      // A faithful stand-in for @adonis-agora/context's scope slot: activate a store seeded from the
      // snapshot, run fn inside it, tear it down after — proving the transport funnels through
      // runStepHandler (the one place the scope is restored), exactly like the broker transports.
      let store: Record<string, unknown> | undefined;
      (globalThis as Record<symbol, unknown>)[CONTEXT_SCOPE] = <T>(
        snapshot: Record<string, unknown> | undefined,
        fn: () => T,
      ): T => {
        const previous = store;
        store = snapshot;
        try {
          return fn();
        } finally {
          store = previous;
        }
      };

      const transport = new EventEmitterTransport();
      let seenByHandler: Record<string, unknown> | undefined;
      transport.handle('payments.charge-card', () => {
        seenByHandler = store;
        return { ok: true };
      });

      const results: StepResult[] = [];
      transport.onResult(async (r) => {
        results.push(r);
      });

      const snapshot = { userRef: 'user-42', tenantId: 'acme', traceId: 'trace-abc' };
      await transport.dispatch(task({ context: snapshot }));
      await waitFor(() => results.length > 0);

      expect(results[0]?.status).toBe('completed');
      expect(seenByHandler).toEqual(snapshot);
      // Scope is torn down once the handler returns — no ambient leak afterwards.
      expect(store).toBeUndefined();
    });
  });
});

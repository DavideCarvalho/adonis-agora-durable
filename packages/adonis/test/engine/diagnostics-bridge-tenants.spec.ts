import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { EngineEvent } from '../../src/interfaces.js';
import { runTraceId } from '../../src/run-trace.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const slot = globalThis as Record<symbol, unknown>;

interface Emitted {
  event: string;
  payload: EngineEvent & { app?: string };
  traceId: string | undefined;
}

function capture(): Emitted[] {
  const seen: Emitted[] = [];
  slot[EMIT_SLOT] = (
    _lib: string,
    event: string,
    payload: unknown,
    options?: { traceId?: string },
  ) => {
    seen.push({ event, payload: payload as Emitted['payload'], traceId: options?.traceId });
  };
  return seen;
}

/** A source the test drives by hand, like the engine's `subscribe`. */
function manualSource() {
  const listeners: Array<(event: EngineEvent) => void> = [];
  return {
    subscribe(listener: (event: EngineEvent) => void) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    push(event: Omit<EngineEvent, 'at'>) {
      for (const l of listeners) l({ ...event, at: new Date() });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  delete slot[EMIT_SLOT];
});

describe('attachDurableDiagnostics on a control plane (tenants)', () => {
  it("stamps every event of a tenant's run with its app, step events included, in the run trace", async () => {
    const seen = capture();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const off = attachDurableDiagnostics(engine, {
      tenants: { namespaceOf: async (id) => (await engine.getRun(id))?.namespace },
    });
    engine.register('w', '1', async (ctx) => ctx.localStep('charge', async () => 'ok'));
    await engine.start('w', {}, 'r-acme', { namespace: 'acme' });
    await engine.waitForRun('r-acme');
    await flush();
    off();

    const events = seen.map((e) => e.event);
    expect(events).toContain('run.started');
    expect(events).toContain('step.started');
    expect(events).toContain('step.completed');
    expect(events).toContain('run.completed');
    expect(seen.every((e) => e.payload.app === 'acme')).toBe(true);
    expect(seen.every((e) => e.traceId === runTraceId('r-acme'))).toBe(true);
    // Emission order is kept: a run's step never lands before it started.
    expect(events.indexOf('step.started')).toBeLessThan(events.indexOf('step.completed'));
    expect(events.indexOf('run.started')).toBeLessThan(events.indexOf('run.completed'));
  });

  it("leaves the control plane's own runs (default or its own namespace) unattributed", async () => {
    const seen = capture();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine, {
      tenants: { namespaceOf: async (id) => (await engine.getRun(id))?.namespace, own: ['ops'] },
    });
    engine.register('w', '1', async () => 'ok');
    await engine.start('w', {}, 'r-default');
    await engine.start('w', {}, 'r-ops', { namespace: 'ops' });
    await engine.waitForRun('r-default');
    await engine.waitForRun('r-ops');
    await flush();
    off();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((e) => 'app' in e.payload)).toBe(false);
    expect(seen.every((e) => e.traceId === undefined)).toBe(true);
  });

  it("reads an unseen run's namespace once, keeps that run's events behind the read, not other runs'", async () => {
    const seen = capture();
    const source = manualSource();
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const off = attachDurableDiagnostics(source, {
      tenants: {
        namespaceOf: async () => {
          reads += 1;
          await gate;
          return 'globex';
        },
      },
    });
    // A step event of a run resumed after a restart: no namespace on it.
    source.push({ type: 'step.started', runId: 'r1', seq: 1, name: 's' });
    source.push({ type: 'step.completed', runId: 'r1', seq: 1, name: 's' });
    // Another run's event is not held behind r1's read.
    source.push({ type: 'run.started', runId: 'r2', namespace: 'acme' });
    expect(seen.map((e) => e.payload.runId)).toEqual(['r2']);
    release();
    await flush();
    off();

    expect(reads).toBe(1);
    expect(seen.map((e) => [e.event, e.payload.runId, e.payload.app])).toEqual([
      ['run.started', 'r2', 'acme'],
      ['step.started', 'r1', 'globex'],
      ['step.completed', 'r1', 'globex'],
    ]);
  });

  it("forwards unattributed when the read fails, and reads again on the run's next event", async () => {
    const seen = capture();
    const source = manualSource();
    let calls = 0;
    const off = attachDurableDiagnostics(source, {
      tenants: {
        namespaceOf: async () => {
          calls += 1;
          if (calls === 1) throw new Error('store down');
          return 'acme';
        },
      },
    });
    source.push({ type: 'step.started', runId: 'r1', seq: 1, name: 's' });
    await flush();
    source.push({ type: 'step.completed', runId: 'r1', seq: 1, name: 's' });
    await flush();
    off();
    expect(calls).toBe(2);
    expect(seen.map((e) => e.payload.app)).toEqual([undefined, 'acme']);
  });

  it('does not let a read that never answers stall the run forever', async () => {
    const seen = capture();
    const source = manualSource();
    const off = attachDurableDiagnostics(source, {
      tenants: { namespaceOf: () => new Promise(() => undefined), lookupTimeoutMs: 10 },
    });
    source.push({ type: 'step.started', runId: 'r1', seq: 1, name: 's' });
    source.push({ type: 'step.completed', runId: 'r1', seq: 1, name: 's' });
    await new Promise((r) => setTimeout(r, 50));
    off();
    expect(seen.map((e) => e.event)).toEqual(['step.started', 'step.completed']);
    expect(seen.every((e) => e.payload.app === undefined)).toBe(true);
  });

  it('standalone (no tenants option) forwards exactly what the engine produced', async () => {
    const seen = capture();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine);
    engine.register('w', '1', async () => 'ok');
    await engine.start('w', {}, 'r-acme', { namespace: 'acme' });
    await engine.waitForRun('r-acme');
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((e) => 'app' in e.payload)).toBe(false);
    expect(seen.every((e) => e.traceId === undefined)).toBe(true);
  });
});

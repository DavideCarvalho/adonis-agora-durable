import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../src/testing/in-memory-transport.js';
import {
  OnEvent,
  OnDiagnostic,
  eventTriggerCanonicalName,
  workflowEvents,
} from '../src/workflow-events.js';
import { attachEventTriggerBridge, type EmitterLike } from '../src/event-trigger-bridge.js';

function makeEngine() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const engine = new WorkflowEngine({ store, transport });
  return { store, engine };
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

/** A fake Adonis emitter: exact `on`/`off` with handler-based dispatch. */
function makeEmitter() {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emitter: EmitterLike = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return emitter;
    },
    off(event, handler) {
      const list = handlers.get(event) ?? [];
      handlers.set(
        event,
        list.filter((h) => h !== handler),
      );
      return emitter;
    },
  };
  return { emitter, emit: (event: string, payload: unknown) => handlers.get(event)?.forEach((h) => h(payload)) };
}

describe('event-triggered workflows', () => {
  it('stamps static on via decorators and normalizes it', () => {
    @OnEvent({ event: 'agora:payments:payment.succeeded' })
    @OnDiagnostic({ lib: 'payments', event: 'payment.succeeded' })
    class W {
      static workflow = { name: 'process-payment' };
      async run() {}
    }
    const triggers = workflowEvents(W);
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toMatchObject({ source: 'emitter', event: 'agora:payments:payment.succeeded', workflow: 'process-payment' });
    expect(triggers[1]).toMatchObject({ source: 'diagnostics', lib: 'payments', event: 'payment.succeeded', workflow: 'process-payment' });
  });

  it('derives the canonical engine event name for exact triggers', () => {
    expect(eventTriggerCanonicalName({ source: 'emitter', event: 'x', workflow: 'w' })).toBe('x');
    expect(eventTriggerCanonicalName({ source: 'diagnostics', lib: 'payments', event: 'payment.succeeded', workflow: 'w' })).toBe('agora:payments:payment.succeeded');
    expect(eventTriggerCanonicalName({ source: 'diagnostics', lib: 'payments', workflow: 'w' })).toBeNull();
  });

  it('bridges an exact Adonis emitter event into a fresh run (payload as input)', async () => {
    const { store, engine } = makeEngine();
    const { emitter, emit } = makeEmitter();

    const seen: Array<{ input: unknown }> = [];
    engine.register('on-x', '1', async (_ctx, input: unknown) => {
      seen.push({ input });
    }, { onEvent: ['x'] });
    engine.registerEventTriggers([{ source: 'emitter', event: 'x', workflow: 'on-x' }]);
    disposers.push(attachEventTriggerBridge(engine.discoveredEventTriggers, { engine, emitter }));

    emit('x', { orderId: '1' });
    // settle: the publish started a run of on-x
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([{ input: { orderId: '1' } }]);
  });

  it('bridges an exact diagnostics channel event via publishEvent', async () => {
    const { store, engine } = makeEngine();
    const seen: Array<{ input: unknown }> = [];
    engine.register('on-payment', '1', async (_ctx, input: unknown) => {
      seen.push({ input });
    }, { onEvent: ['agora:payments:payment.succeeded'] });
    engine.registerEventTriggers([
      { source: 'diagnostics', lib: 'payments', event: 'payment.succeeded', workflow: 'on-payment' },
    ]);
    disposers.push(attachEventTriggerBridge(engine.discoveredEventTriggers, { engine }));

    channel('agora:payments:payment.succeeded').publish({
      v: 1,
      lib: 'payments',
      event: 'payment.succeeded',
      payload: { externalReference: 'pay_1' },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([{ input: { externalReference: 'pay_1' } }]);
  });

  it('starts a workflow directly for regex/any diagnostics triggers', async () => {
    // Seed the diagnostics registry (as the loaded `@adonis-agora/diagnostics` would), so
    // the bridge can discover the `agora:payments:*` channels.
    const registryKey = Symbol.for('@agora/diagnostics:registry');
    const registry = (globalThis as Record<symbol, unknown>)[registryKey] as
      | { channels: Set<string>; listeners: Set<(name: string) => void> }
      | undefined;
    const seeded =
      registry ?? { channels: new Set<string>(), listeners: new Set<(name: string) => void>() };
    (globalThis as Record<symbol, unknown>)[registryKey] = seeded;
    seeded.channels.add('agora:payments:payment.succeeded');
    seeded.channels.add('agora:payments:charge.created');

    const { store, engine } = makeEngine();
    const seen: Array<{ input: unknown }> = [];
    engine.register('on-any', '1', async (_ctx, input: unknown) => {
      seen.push({ input });
    });
    engine.registerEventTriggers([
      { source: 'diagnostics', lib: 'payments', event: /^payment\./, workflow: 'on-any' },
    ]);
    disposers.push(attachEventTriggerBridge(engine.discoveredEventTriggers, { engine }));

    channel('agora:payments:payment.succeeded').publish({
      v: 1,
      lib: 'payments',
      event: 'payment.succeeded',
      payload: { id: 'p1' },
    });
    // A non-matching event must NOT start it.
    channel('agora:payments:charge.created').publish({
      v: 1,
      lib: 'payments',
      event: 'charge.created',
      payload: { id: 'c1' },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([{ input: { id: 'p1' } }]);
  });

  it('detaches all subscriptions on dispose', async () => {
    const { store, engine } = makeEngine();
    const { emitter, emit } = makeEmitter();
    const seen: Array<{ input: unknown }> = [];
    engine.register('on-x', '1', async (_ctx, input: unknown) => {
      seen.push({ input });
    }, { onEvent: ['x'] });
    engine.registerEventTriggers([{ source: 'emitter', event: 'x', workflow: 'on-x' }]);
    const dispose = attachEventTriggerBridge(engine.discoveredEventTriggers, { engine, emitter });
    dispose();

    emit('x', { n: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
  });
});
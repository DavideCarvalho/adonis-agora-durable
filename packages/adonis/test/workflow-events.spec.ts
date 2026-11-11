import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { attachEventTriggerBridge, type EmitterLike } from '../src/event-trigger-bridge.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../src/testing/in-memory-transport.js';
import { eventTriggerCanonicalName, OnEvent, workflowEvents } from '../src/workflow-events.js';

function makeEngine() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const engine = new WorkflowEngine({ store, transport });
  return { store, engine };
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
  return {
    emitter,
    emit: (event: string, payload: unknown) => {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
}

describe('event-triggered workflows', () => {
  it('stamps static on via decorators and normalizes it', () => {
    @OnEvent({ event: 'order:placed' })
    @OnEvent({ event: 'order:paid' })
    class W {
      static workflow = { name: 'process-order' };
      async run() {}
    }
    const triggers = workflowEvents(W);
    expect(triggers).toEqual([
      { source: 'emitter', event: 'order:placed', workflow: 'process-order' },
      { source: 'emitter', event: 'order:paid', workflow: 'process-order' },
    ]);
  });

  it('fails loudly on a `static on` trigger with the removed diagnostics source', () => {
    class W {
      static workflow = { name: 'legacy' };
      static on = [{ source: 'diagnostics', lib: 'payments', event: 'payment.succeeded' }];
      async run() {}
    }
    expect(() => workflowEvents(W)).toThrow(/source "diagnostics".*diagnostics listener/);
  });

  it('derives the canonical engine event name', () => {
    expect(eventTriggerCanonicalName({ source: 'emitter', event: 'x', workflow: 'w' })).toBe('x');
  });

  it('bridges an exact Adonis emitter event into a fresh run (payload as input)', async () => {
    const { engine } = makeEngine();
    const { emitter, emit } = makeEmitter();

    const seen: Array<{ input: unknown }> = [];
    engine.register(
      'on-x',
      '1',
      async (_ctx, input: unknown) => {
        seen.push({ input });
      },
      { onEvent: ['x'] },
    );
    engine.registerEventTriggers([{ source: 'emitter', event: 'x', workflow: 'on-x' }]);
    disposers.push(attachEventTriggerBridge(engine.discoveredEventTriggers, { engine, emitter }));

    emit('x', { orderId: '1' });
    // settle: the publish started a run of on-x
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toEqual([{ input: { orderId: '1' } }]);
  });

  it('detaches all subscriptions on dispose', async () => {
    const { engine } = makeEngine();
    const { emitter, emit } = makeEmitter();
    const seen: Array<{ input: unknown }> = [];
    engine.register(
      'on-x',
      '1',
      async (_ctx, input: unknown) => {
        seen.push({ input });
      },
      { onEvent: ['x'] },
    );
    engine.registerEventTriggers([{ source: 'emitter', event: 'x', workflow: 'on-x' }]);
    const dispose = attachEventTriggerBridge(engine.discoveredEventTriggers, { engine, emitter });
    dispose();

    emit('x', { n: 1 });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
  });
});

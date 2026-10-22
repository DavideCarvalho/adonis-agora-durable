import { channel } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { attachEventTriggerBridge, type EmitterLike } from '../src/event-trigger-bridge.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';

/** A failing trigger start/publish must be reported, never left as an unhandled rejection. */
describe('event-trigger bridge — a failing start or publish is reported, not unhandled', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  const disposers: Array<() => void> = [];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    warn.mockRestore();
    while (disposers.length) disposers.pop()?.();
  });
  const flush = () => new Promise((r) => setTimeout(r, 50));

  it('regex diagnostics trigger whose workflow is not registered', async () => {
    const registryKey = Symbol.for('@agora/diagnostics:registry');
    const g = globalThis as Record<symbol, unknown>;
    const registry = (g[registryKey] as
      | { channels: Set<string>; listeners: Set<(name: string) => void> }
      | undefined) ?? { channels: new Set<string>(), listeners: new Set() };
    g[registryKey] = registry;
    registry.channels.add('agora:billing:invoice.paid');

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    engine.registerEventTriggers([
      { source: 'diagnostics', lib: 'billing', event: /^invoice\./, workflow: 'not-registered' },
    ]);
    disposers.push(attachEventTriggerBridge(engine.discoveredEventTriggers, { engine }));

    channel('agora:billing:invoice.paid').publish({ v: 1, payload: { id: 'inv_1' } });
    await flush();
    expect(unhandled).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.join(' '))).toContain('not-registered');
  });

  it('emitter trigger whose publishEvent rejects', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    engine.publishEvent = async () => {
      throw new Error('store down');
    };
    const handlers = new Map<string, (p: unknown) => void>();
    const emitter: EmitterLike = {
      on: (e, h) => handlers.set(e, h),
      off: (e) => handlers.delete(e),
    };
    engine.registerEventTriggers([{ source: 'emitter', event: 'order:placed', workflow: 'x' }]);
    const reported: unknown[] = [];
    disposers.push(
      attachEventTriggerBridge(engine.discoveredEventTriggers, {
        engine,
        emitter,
        onError: (err) => reported.push(err),
      }),
    );

    handlers.get('order:placed')?.({ id: 1 });
    await flush();
    expect(unhandled).toEqual([]);
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe('store down');
  });
});

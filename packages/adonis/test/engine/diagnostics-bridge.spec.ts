import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const slot = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete slot[EMIT_SLOT];
});

describe('attachDurableDiagnostics', () => {
  it('re-emits engine lifecycle events on the diagnostics slot as durable:<type>', async () => {
    const seen: Array<{ lib: string; event: string }> = [];
    slot[EMIT_SLOT] = (lib: string, event: string) => seen.push({ lib, event });

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine);
    engine.register('w', '1', async () => 'ok');
    await engine.start('w', {}, 'r1');
    await engine.waitForRun('r1');
    off();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.lib === 'durable')).toBe(true);
    expect(seen.some((e) => e.event === 'run.started')).toBe(true);
    expect(seen.some((e) => e.event === 'run.completed')).toBe(true);
  });

  it('is inert when no diagnostics emit slot is present', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine);
    engine.register('w', '1', async () => 'ok');
    await engine.start('w', {}, 'r2'); // must not throw with the slot empty
    await engine.waitForRun('r2');
    off();
  });

  it('stops forwarding after the returned unsubscribe is called', async () => {
    const seen: string[] = [];
    slot[EMIT_SLOT] = (_lib: string, event: string) => seen.push(event);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine);
    off();
    engine.register('w', '1', async () => 'ok');
    await engine.start('w', {}, 'r3');
    await engine.waitForRun('r3');
    expect(seen).toEqual([]);
  });

  it('stamps parentRunId on the events of a child run the engine started', async () => {
    const seen: Array<{ runId: string; parentRunId?: string }> = [];
    slot[EMIT_SLOT] = (_lib: string, _event: string, payload: unknown) =>
      seen.push(payload as { runId: string; parentRunId?: string });
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const off = attachDurableDiagnostics(engine);
    engine.register('item', '1', async () => 'ok');
    engine.register('batch', '1', async (ctx) => {
      await ctx.all('item', [{}, {}]);
      return ctx.child('item', {});
    });
    await engine.start('batch', {}, 'p');
    for (let i = 0; i < 200 && (await store.getRun('p'))?.status !== 'completed'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    off();

    const children = new Set(seen.filter((e) => e.parentRunId === 'p').map((e) => e.runId));
    expect([...children].sort()).toEqual(['p.all.0.0', 'p.all.0.1', 'p.child.2']);
    expect(seen.filter((e) => e.runId === 'p').every((e) => e.parentRunId === undefined)).toBe(
      true,
    );
  });
});

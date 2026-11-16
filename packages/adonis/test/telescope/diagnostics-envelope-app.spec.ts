import { subscribe, unsubscribe } from 'node:diagnostics_channel';
// The real package: importing it publishes its `emit` on the diagnostics slot.
import '@adonis-agora/diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import { attachDurableDiagnostics } from '../../src/diagnostics-bridge.js';
import { InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import { runTraceId } from '../../src/run-trace.js';
import { buildDurableEntry } from '../../src/telescope/index.js';

interface Envelope {
  lib: string;
  event: string;
  ts: number;
  traceId?: string;
  app?: string;
  payload: { runId: string; app?: string; namespace?: string };
}

const subs: Array<() => void> = [];
afterEach(() => {
  for (const off of subs.splice(0)) off();
});

function listen(events: string[]): Envelope[] {
  const seen: Envelope[] = [];
  for (const event of events) {
    const name = `agora:durable:${event}`;
    const fn = (msg: unknown) => seen.push(msg as Envelope);
    subscribe(name, fn);
    subs.push(() => unsubscribe(name, fn));
  }
  return seen;
}

describe('the control plane on @adonis-agora/diagnostics (envelope `app`)', () => {
  it("names a tenant's app on the envelope, step events included, and Telescope tags it from there", async () => {
    const seen = listen(['run.started', 'step.started', 'step.completed', 'run.completed']);
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const off = attachDurableDiagnostics(engine, {
      tenants: { namespaceOf: async (id) => (await engine.getRun(id))?.namespace },
    });
    subs.push(off);
    engine.register('w', '1', async (ctx) => ctx.localStep('s', async () => 'ok'));
    await engine.start('w', {}, 'r-acme', { namespace: 'acme' });
    await engine.waitForRun('r-acme');
    await engine.start('w', {}, 'r-own');
    await engine.waitForRun('r-own');
    await new Promise((r) => setTimeout(r, 0));

    const acme = seen.filter((e) => e.payload.runId === 'r-acme');
    expect(acme.map((e) => e.event)).toEqual([
      'run.started',
      'step.started',
      'step.completed',
      'run.completed',
    ]);
    for (const e of acme) {
      expect(e.app).toBe('acme');
      expect(e.payload.namespace).toBe('acme');
      expect(e.traceId).toBe(runTraceId('r-acme'));
      expect(buildDurableEntry(e).tags).toEqual(
        expect.arrayContaining(['lib:durable', 'app:acme']),
      );
    }
    const own = seen.filter((e) => e.payload.runId === 'r-own');
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((e) => e.app === undefined)).toBe(true);
  });

  it('prefers the envelope `app` over the payload one when tagging', () => {
    const entry = buildDurableEntry({
      lib: 'durable',
      event: 'run.started',
      ts: Date.now(),
      app: 'acme',
      payload: { type: 'run.started', runId: 'r1', app: 'stale' },
    } as never);
    expect(entry.tags).toContain('app:acme');
    expect(entry.tags).not.toContain('app:stale');
  });
});

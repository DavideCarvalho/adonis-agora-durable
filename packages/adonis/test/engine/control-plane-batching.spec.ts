import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { ControlMessage, ControlPlane } from '../../src/interfaces.js';
import { isRemoteEvent } from '../../src/remote-event.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * A step's lifecycle events reach other instances in batches: the ones emitted while a control-plane
 * publish is in flight share the next message. A run's own events still travel one per message, so an
 * instance that only reads single events (an older one) keeps every run event.
 */

/** A control plane over the in-memory transport whose publishes take a few milliseconds, as Redis does. */
class SlowControlPlane implements ControlPlane {
  readonly sent: ControlMessage[] = [];
  constructor(private readonly inner: InMemoryTransport) {}
  async publishControl(msg: ControlMessage): Promise<void> {
    this.sent.push(msg);
    await new Promise((r) => setTimeout(r, 5));
    await this.inner.publishControl(msg);
  }
  onControl(handler: (msg: ControlMessage) => void): void {
    this.inner.onControl(handler);
  }
}

function twoInstances() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const control = new SlowControlPlane(transport);
  const worker = new WorkflowEngine({
    store,
    transport,
    controlPlane: control,
    instanceId: 'worker',
  });
  const dashboard = new WorkflowEngine({
    store,
    transport,
    controlPlane: control,
    instanceId: 'dashboard',
  });
  return { control, transport, worker, dashboard };
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('step events on the control plane', () => {
  it('reach another instance in a few messages, every one of them, in emit order', async () => {
    const { control, worker, dashboard } = twoInstances();
    const seen: string[] = [];
    dashboard.subscribe((e) => seen.push(e.seq === undefined ? e.type : `${e.type}#${e.seq}`));
    worker.register('wf', '1', async (ctx) => {
      for (let i = 0; i < 200; i++) await ctx.localStep(`s${i}`, async () => i);
      return 'ok';
    });

    await startRun(worker, 'wf', {}, 'run1');
    await settle();

    const stepEvents = seen.filter((t) => t.startsWith('step.'));
    expect(stepEvents).toHaveLength(400);
    expect(seen[0]).toBe('run.started');
    expect(seen.at(-1)).toBe('run.completed');
    // Every step's started precedes its completed, and the steps keep their order.
    const expected = Array.from({ length: 200 }, (_, i) => [
      `step.started#${i}`,
      `step.completed#${i}`,
    ]).flat();
    expect(stepEvents).toEqual(expected);
    const stepMessages = control.sent.filter(
      (m) => (m.kind === 'event' && m.event.type.startsWith('step.')) || m.kind === 'events',
    );
    expect(stepMessages.length).toBeLessThan(400 / 4);
  });

  it('sends a run event as a single event message, which an instance reading only those still gets', async () => {
    const { control, transport, worker } = twoInstances();
    const olderInstance: string[] = [];
    transport.onControl((msg) => {
      if (msg.from === 'older') return;
      if (msg.kind === 'event') olderInstance.push(msg.event.type);
    });
    worker.register('wf', '1', async (ctx) => {
      for (let i = 0; i < 50; i++) await ctx.localStep(`s${i}`, async () => i);
      return 'ok';
    });

    await startRun(worker, 'wf', {}, 'run1');
    await settle();

    expect(olderInstance.filter((t) => t.startsWith('run.'))).toEqual([
      'run.started',
      'run.completed',
    ]);
    for (const msg of control.sent) {
      if (msg.kind === 'events')
        expect(msg.events.every((e) => e.type.startsWith('step.'))).toBe(true);
    }
  });

  it('marks batched events as remote on the instance that receives them', async () => {
    const { worker, dashboard } = twoInstances();
    const remote: boolean[] = [];
    dashboard.subscribe((e) => {
      if (e.type.startsWith('step.')) {
        remote.push(isRemoteEvent(e));
      }
    });
    worker.register('wf', '1', async (ctx) => {
      for (let i = 0; i < 20; i++) await ctx.localStep(`s${i}`, async () => i);
      return 'ok';
    });
    await startRun(worker, 'wf', {}, 'run1');
    await settle();
    expect(remote.length).toBe(40);
    expect(remote.every(Boolean)).toBe(true);
  });
});

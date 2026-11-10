import { describe, expect, it } from 'vitest';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { controlChannel, effectivePrefix } from '../../src/transports/bullmq/naming.js';

/**
 * The control channel folds the namespace in exactly like the BullMQ transport's names (and
 * nestjs-durable's `${effectivePrefix}-control`), so a namespaced Agora fleet and a namespaced
 * NestJS/Python fleet on one Redis hear each other's cancels and lifecycle events.
 */
function fakeConnection() {
  const published: string[] = [];
  const messages: Array<{ channel: string; kind: string; type?: string }> = [];
  const subscribed: string[] = [];
  return {
    published,
    messages,
    subscribed,
    connection: {
      publish(channel: string, payload: string) {
        published.push(channel);
        const msg = JSON.parse(payload) as { kind: string; event?: { type: string } };
        messages.push({ channel, kind: msg.kind, ...(msg.event ? { type: msg.event.type } : {}) });
        return Promise.resolve(1);
      },
      subscribe(channel: string) {
        subscribed.push(channel);
        return Promise.resolve();
      },
    },
  };
}

function plane(options: { prefix?: string; namespace?: string } = {}) {
  const fake = fakeConnection();
  const cp = new RedisControlPlane({
    connection: fake.connection,
    pingIntervalMs: false,
    ...options,
  });
  return { cp, ...fake };
}

describe('RedisControlPlane channel namespace folding', () => {
  it('keeps the bare channel with no namespace or the default one', () => {
    expect(plane().cp.channel).toBe('durable-control');
    expect(plane({ namespace: 'default' }).cp.channel).toBe('durable-control');
  });

  it('folds an explicit namespace in, as nestjs-durable does', () => {
    expect(plane({ namespace: 'dev-alice' }).cp.channel).toBe('durable-dev-alice-control');
    expect(plane({ prefix: 'flip', namespace: 'dev-bob' }).cp.channel).toBe('flip-dev-bob-control');
  });

  it('matches the BullMQ transport naming for the same prefix and namespace', () => {
    for (const [prefix, namespace] of [
      ['durable', undefined],
      ['durable', 'default'],
      ['durable', 'tenant-a'],
      ['acme', 'eu'],
    ] as const) {
      expect(plane({ prefix, ...(namespace ? { namespace } : {}) }).cp.channel).toBe(
        controlChannel(effectivePrefix(prefix, namespace)),
      );
    }
  });

  it("adopts the engine's namespace before subscribing, and publishes on the same channel", async () => {
    const { cp, published, subscribed } = plane();
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      controlPlane: cp,
      namespace: 'tenant-a',
    });
    expect(subscribed).toEqual(['durable-tenant-a-control']);
    await cp.publishControl({ kind: 'cancel', runId: 'r1' });
    expect(published).toEqual(['durable-tenant-a-control']);
  });

  it("an explicit namespace wins over the engine's", () => {
    const { cp, subscribed } = plane({ namespace: 'other' });
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      controlPlane: cp,
      namespace: 'tenant-a',
    });
    expect(subscribed).toEqual(['durable-other-control']);
  });

  it('an operator engine (no namespace) stays on the bare channel', () => {
    const { cp, subscribed } = plane();
    new WorkflowEngine({ store: new InMemoryStateStore(), controlPlane: cp });
    expect(subscribed).toEqual(['durable-control']);
  });
});

describe('RedisControlPlane publishes a message about a run on that run’s namespace channel', () => {
  it('routes by target namespace, and keeps the own channel without one', async () => {
    const { cp, published } = plane({ namespace: 'console' });
    await cp.publishControl({ kind: 'cancel', runId: 'r1' }, { namespace: 'bulas' });
    await cp.publishControl({ kind: 'cancel', runId: 'r2' }, { namespace: 'default' });
    await cp.publishControl({ kind: 'cancel', runId: 'r3' }, { namespace: '' });
    await cp.publishControl({ kind: 'schedulePause', key: 'k', paused: true });
    await cp.publishControl({ kind: 'cancel', runId: 'r4' }, { namespace: undefined });
    expect(published).toEqual([
      'durable-bulas-control',
      'durable-control',
      'durable-control',
      'durable-console-control', // no run: the publisher's own (explicitly pinned) channel
      'durable-console-control', // a run of unknown namespace: the publisher's own channel
    ]);
  });

  it('an operator engine sends a namespaced run’s cancel and lifecycle to that namespace', async () => {
    const { cp, messages } = plane();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), controlPlane: cp });
    engine.register('parked', '1', async (ctx) => {
      await ctx.localStep('prep', async () => 1);
      return ctx.waitForSignal('never-sent');
    });
    await engine.start('parked', {}, 'b1', { namespace: 'bulas' });
    await new Promise((r) => setTimeout(r, 50));
    await engine.cancel('b1');
    await new Promise((r) => setTimeout(r, 20));

    const byKind = (kind: string) => messages.filter((m) => m.kind === kind);
    expect(byKind('cancel').map((m) => m.channel)).toEqual(['durable-bulas-control']);
    expect(byKind('enqueued').map((m) => m.channel)).toEqual(['durable-bulas-control']);
    const runEvents = messages.filter((m) => m.type?.startsWith('run.'));
    expect(runEvents.length).toBeGreaterThan(0);
    expect(new Set(runEvents.map((m) => m.channel))).toEqual(new Set(['durable-bulas-control']));
    // Step events carry no namespace: they stay on the publisher's own channel.
    const stepEvents = messages.filter((m) => m.type?.startsWith('step.') || m.kind === 'events');
    expect(stepEvents.length).toBeGreaterThan(0);
    expect(new Set(stepEvents.map((m) => m.channel))).toEqual(new Set(['durable-control']));
  });

  it('a namespaced engine sends a default run’s cancel to the bare channel', async () => {
    const store = new InMemoryStateStore();
    const operator = new WorkflowEngine({ store });
    operator.register('parked', '1', async (ctx) => ctx.waitForSignal('never-sent'));
    await operator.start('parked', {}, 'd1');
    await new Promise((r) => setTimeout(r, 20));

    const { cp, messages } = plane();
    const bulas = new WorkflowEngine({ store, controlPlane: cp, namespace: 'bulas' });
    await bulas.cancel('d1');
    expect(messages.filter((m) => m.kind === 'cancel').map((m) => m.channel)).toEqual([
      'durable-control',
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult, Transport } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A transport that records every `useNamespace` call so we can assert the engine propagated its own. */
class SpyTransport implements Transport {
  readonly namespaces: string[] = [];
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (b: Heartbeat) => Promise<void>): void {}
  useNamespace(namespace: string): void {
    this.namespaces.push(namespace);
  }
}

describe('engine → transport namespace propagation', () => {
  it('propagates a non-default namespace to a single transport', () => {
    const transport = new SpyTransport();
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport,
      namespace: 'dev-alice',
    });
    expect(transport.namespaces).toEqual(['dev-alice']);
  });

  it('propagates an explicit "default" (the transport itself makes default a no-op)', () => {
    const transport = new SpyTransport();
    new WorkflowEngine({ store: new InMemoryStateStore(), transport, namespace: 'default' });
    expect(transport.namespaces).toEqual(['default']);
  });

  it('propagates NOTHING for an operator — not propagating IS the bare prefix', () => {
    const transport = new SpyTransport();
    new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    // An engine with no namespace drives every pool, so it has to reach every pool's queues. Leaving
    // the transport untouched is what keeps it on the bare names those queues are derived from.
    expect(transport.namespaces).toEqual([]);
  });

  it('propagates the namespace to every transport in a pool', () => {
    const a = new SpyTransport();
    const b = new SpyTransport();
    new WorkflowEngine({
      store: new InMemoryStateStore(),
      transports: [
        { id: 'a', transport: a },
        { id: 'b', transport: b },
      ],
      namespace: 'dev-alice',
    });
    expect(a.namespaces).toEqual(['dev-alice']);
    expect(b.namespaces).toEqual(['dev-alice']);
  });

  it('does not throw when a transport omits the optional useNamespace hook', () => {
    // A bare transport without `useNamespace` must be skipped, not crash the pool fan-out.
    const bare: Transport = {
      async dispatch() {},
      onResult() {},
      onHeartbeat() {},
    };
    expect(
      () =>
        new WorkflowEngine({
          store: new InMemoryStateStore(),
          transport: bare,
          namespace: 'dev-alice',
        }),
    ).not.toThrow();
  });

  it('does not throw when there are no transports', () => {
    expect(
      () => new WorkflowEngine({ store: new InMemoryStateStore(), namespace: 'dev-alice' }),
    ).not.toThrow();
  });
});

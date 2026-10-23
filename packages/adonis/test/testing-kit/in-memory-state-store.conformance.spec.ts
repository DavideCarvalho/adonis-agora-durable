import { describe, expect, it } from 'vitest';
import { CodecStateStore, InMemoryStateStore } from '../../src/index.js';
import { runStateStoreContract } from '../../src/testing-kit/state-store-conformance.js';

// The in-memory store is the CANONICAL implementation of the StateStore contract — every SQL adapter
// must behave identically to it. Running the same shared suite against it here pins that reference
// behavior (lives in the testing package since core can't depend on testing).
runStateStoreContract('InMemoryStateStore', async () => ({
  store: new InMemoryStateStore(),
  cleanup: async () => undefined,
}));

// The wrapper must stay contract-conformant too, including the optional fan methods it forwards.
runStateStoreContract('CodecStateStore(InMemoryStateStore)', async () => ({
  store: new CodecStateStore(new InMemoryStateStore(), {
    encode: (v) => ({ wrapped: v }),
    decode: (v) => (v as { wrapped: unknown }).wrapped,
  }),
  cleanup: async () => undefined,
}));

describe('InMemoryStateStore fan methods', () => {
  it('implements every optional method the ctx.all join barrier and folding use', () => {
    const store = new InMemoryStateStore();
    expect(store.hasSignalWaiter).toBeTypeOf('function');
    expect(store.registerChildWaits).toBeTypeOf('function');
    expect(store.compactCheckpoints).toBeTypeOf('function');
    expect(store.listSignalWaitersByRunIds).toBeTypeOf('function');
    expect(store.getRuns).toBeTypeOf('function');
    expect(store.releaseRunLockUnlessWakeRequested).toBeTypeOf('function');
  });
});

describe('CodecStateStore getRuns', () => {
  it('forwards getRuns and decodes each run, only when the inner store has it', async () => {
    const inner = new InMemoryStateStore();
    const codec = new CodecStateStore(inner, {
      encode: (v) => ({ wrapped: v }),
      decode: (v) => (v as { wrapped: unknown }).wrapped,
    });
    const at = new Date();
    await codec.createRun({
      id: 'r1',
      workflow: 'w',
      workflowVersion: '1',
      status: 'completed',
      input: { a: 1 },
      output: 'out',
      createdAt: at,
      updatedAt: at,
    });
    const [got] = (await codec.getRuns?.(['r1'])) ?? [];
    expect(got?.input).toEqual({ a: 1 });
    expect(got?.output).toBe('out');
    const without = new Proxy(inner, {
      get: (t, p, r) => (p === 'getRuns' ? undefined : Reflect.get(t, p, r)),
    });
    expect(new CodecStateStore(without, { encode: (v) => v, decode: (v) => v }).getRuns).toBe(
      undefined,
    );
  });
});

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
  });
});

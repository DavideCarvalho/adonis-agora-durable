import { describe, it } from 'vitest';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { assertMidTurnChildWake } from '../../src/testing-kit/conformance.js';
import { EventEmitterTransport } from '../../src/transports/event-emitter.js';

// The in-process transports (no run queue): the child's wake is a direct resume on the instance that
// delivered it, which finds the parent's lease held by the instance running the parent's turn. The
// run-queue transports run the same case through the run-dispatch contract.
describe.each([
  ['InMemoryTransport', () => new InMemoryTransport()],
  ['EventEmitterTransport', () => new EventEmitterTransport()],
] as const)('%s: a child finishing mid-turn', (_name, makeTransport) => {
  it.each([
    ['all', false],
    ['allSettled', false],
    ['child', false],
    ['all', true],
    ['allSettled', true],
    ['child', true],
  ] as const)(
    'wakes the parent once the turn lets go of the lease (%s, holder skips its re-check: %s)',
    async (shape, holderLosesItsRecheck) => {
      await assertMidTurnChildWake({ shape, holderLosesItsRecheck, makeTransport });
    },
    60_000,
  );
});

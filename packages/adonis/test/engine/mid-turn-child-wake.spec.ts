import { describe, it } from 'vitest';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import {
  assertMidTurnChildWake,
  assertSingleInstanceSingletonFan,
  MID_TURN_VARIANTS,
} from '../../src/testing-kit/conformance.js';
import { EventEmitterTransport } from '../../src/transports/event-emitter.js';

// The in-process transports (no run queue): the child's wake is a direct resume on the instance that
// delivered it, which finds the parent's lease held by the instance running the parent's turn. The
// run-queue transports run the same cases through the run-dispatch contract.
describe.each([
  ['InMemoryTransport', () => new InMemoryTransport()],
  ['EventEmitterTransport', () => new EventEmitterTransport()],
] as const)('%s: a child finishing mid-turn', (_name, makeTransport) => {
  for (const shape of ['all', 'allSettled', 'child'] as const) {
    for (const variant of MID_TURN_VARIANTS) {
      it(`wakes the parent (${shape}, ${variant.label})`, async () => {
        await assertMidTurnChildWake({ shape, ...variant, makeTransport });
      }, 60_000);
    }
  }
  for (const mode of ['all', 'allSettled'] as const) {
    for (const concurrency of [undefined, 2]) {
      it(`one instance: a singleton parent's ctx.${mode} fan (concurrency ${concurrency}) completes`, async () => {
        await assertSingleInstanceSingletonFan({ mode, concurrency, makeTransport });
      }, 60_000);
    }
  }
});

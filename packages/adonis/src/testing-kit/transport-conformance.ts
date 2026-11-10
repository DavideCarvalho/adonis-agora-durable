import { InMemoryStateStore, type Transport, WorkflowEngine } from '../index.js';

/** A transport that can register worker handlers (every shipped transport does). */
export type HandleableTransport = Transport & {
  handle(name: string, fn: (input: unknown) => Promise<unknown>): void;
  close?(): Promise<void>;
};

/** The cross-runtime routing name the conformance worker serves — a plain string `ctx.step` call
 *  (no def factory needed). */
const ECHO = 'conformance.echo';

/**
 * A durable `ctx.step` suspends the run; the worker result resumes it asynchronously (on whatever
 * tick/poll the transport delivers on). Poll the store until the run reaches a terminal state —
 * with a generous budget so a poll-based transport (DB/SQS) has time to round-trip.
 */
async function settle(store: InMemoryStateStore, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getRun(runId);
    if (
      run &&
      run.status !== 'pending' &&
      run.status !== 'running' &&
      run.status !== 'suspended' &&
      run.status !== 'cancelling'
    )
      return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
}

/**
 * The contract every `Transport` must satisfy: a remote step dispatched through it round-trips to a
 * worker and back (success), and a throwing handler surfaces as a failed run (failure). Point it at
 * a freshly constructed transport (engine-side + worker `group` in one instance) to prove parity —
 * useful when adding a new transport. Throws on any mismatch; closes the transport when done.
 *
 * `idPrefix` keeps run ids unique across invocations against real, shared infra (queues/tables).
 */
export async function assertTransportConformance(
  transport: HandleableTransport,
  idPrefix = 'conf',
): Promise<void> {
  try {
    // One engine/store/transport — a durable remote step routes its result back to this engine,
    // which resumes the run. (Two engines on one transport would fight over the result stream.)
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport });
    engine.register(
      'conf-ok',
      '1',
      async (ctx) => (await ctx.step<{ doubled: number }>(ECHO, { n: 21 })).doubled,
    );
    engine.register('conf-fail', '1', async (ctx) => ctx.step(ECHO, { n: 1 }));

    // success: the worker doubles the input
    transport.handle('conformance.echo', async (input) => ({
      doubled: (input as { n: number }).n * 2,
    }));
    await engine.start('conf-ok', {}, `${idPrefix}-ok`);
    const ok = await settle(store, `${idPrefix}-ok`);
    if (ok.status !== 'completed' || ok.output !== 42) {
      throw new Error(`expected completed/42, got ${JSON.stringify(ok)}`);
    }

    // failure: a throwing handler surfaces as a failed run (re-register the same step to throw)
    transport.handle('conformance.echo', async () => {
      throw new Error('handler boom');
    });
    await engine.start('conf-fail', {}, `${idPrefix}-fail`);
    const failed = await settle(store, `${idPrefix}-fail`);
    if (failed.status !== 'failed') {
      throw new Error(`expected failed, got ${JSON.stringify(failed)}`);
    }
  } finally {
    await transport.close?.();
  }
}

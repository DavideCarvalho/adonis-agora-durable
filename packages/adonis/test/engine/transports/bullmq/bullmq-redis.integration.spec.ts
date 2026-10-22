import { afterAll, describe, expect, it } from 'vitest';
import type { StepResult } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * Real-backend interop smoke test (spec §11.2). Gated on `DURABLE_REDIS_URL` — skipped locally without it, REQUIRED in
 * CI (the workflow provides a Redis service); it exercises the real `bullmq`/`ioredis` deps. Run it against a live Redis:
 *
 *   DURABLE_REDIS_URL=redis://localhost:6379 node_modules/.bin/vitest run bullmq-redis
 *
 * It proves the same keys the aviary Python worker uses actually round-trip: an engine-side transport
 * dispatches a step, a worker-side transport (same prefix) runs the handler, and the result flows back
 * on `${P}-results`. A Python worker on the same prefix would be a drop-in substitute for the worker side.
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers) await c().catch(() => {});
});

describe.skipIf(!REDIS_URL)('BullMQTransport over real Redis', () => {
  it('round-trips a dispatched step through a worker back to onResult', async () => {
    const prefix = uniqueRedisPrefix('durable-it');
    const connection = { url: REDIS_URL } as unknown;

    const engine = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'ts-engine',
    });
    const worker = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'ts-worker',
    });
    closers.push(
      () => engine.close(),
      () => worker.close(),
    );

    worker.handle('interop.echo', async (input) => ({ echoed: input }));

    const got = new Promise<StepResult>((resolve) => {
      engine.onResult(async (result) => {
        resolve(result);
      });
    });

    await engine.dispatch({
      runId: 'it-run',
      seq: 1,
      name: 'interop.echo',
      stepId: 'it-run:1',
      group: 'interop.echo',
      input: { hello: 'world' },
      attempt: 0,
    });

    const result = await Promise.race([
      got,
      new Promise<StepResult>((_r, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for result')), 10_000),
      ),
    ]);

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ echoed: { hello: 'world' } });
    expect(result.stepId).toBe('it-run:1');
  }, 20_000);
});

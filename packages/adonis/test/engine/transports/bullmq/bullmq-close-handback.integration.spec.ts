import { afterAll, describe, expect, it } from 'vitest';
import type { StepResult } from '../../../../src/interfaces.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * The close() hand-back against real BullMQ (the unit spec, `bullmq-close-handback.spec.ts`, runs on
 * fakes). It proves what only the real broker can: BullMQ's worker accepts the name-matched
 * `DelayedError` (the job is neither completed nor failed), `moveToDelayed` under the processor's lock
 * token puts the job back, and a second worker runs it at once, on the same attempt, instead of BullMQ
 * finding it stalled after the first process is gone.
 *
 *   DURABLE_REDIS_URL=redis://localhost:6379 node_modules/.bin/vitest run bullmq-close-handback
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers) await c().catch(() => {});
});

describe.skipIf(!REDIS_URL)('BullMQTransport close() hand-back over real Redis', () => {
  it('a step still running at close() is redelivered to another worker at once', async () => {
    const prefix = uniqueRedisPrefix('durable-handback');
    const connection = { url: REDIS_URL } as unknown;
    const errors: unknown[] = [];

    const engine = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'engine',
    });
    closers.push(() => engine.close());
    const results: StepResult[] = [];
    engine.onResult(async (result) => {
      results.push(result);
    });

    // Worker A: a step longer than its shutdown budget, which ignores log.signal.
    const a = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'A',
      closeTimeoutMs: 200,
      onError: (err) => errors.push(err),
    });
    let startedOnA = false;
    let signalOnA: AbortSignal | undefined;
    a.handle('crawl.long', async (_input, log) => {
      startedOnA = true;
      signalOnA = log.signal;
      await new Promise((r) => setTimeout(r, 3_000));
      return 'from A';
    });

    await engine.dispatch({
      runId: 'hb-run',
      seq: 1,
      name: 'crawl.long',
      stepId: 'hb-run:1',
      group: 'crawl.long',
      input: {},
      attempt: 0,
    });
    const until = async (cond: () => boolean, ms: number) => {
      const t0 = Date.now();
      while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await until(() => startedOnA, 10_000);

    const t0 = Date.now();
    await a.close();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(signalOnA?.aborted).toBe(true);
    expect(errors).toEqual([]);

    // Worker B picks the handed-back job up right away (BullMQ's stalled check would take 30s+).
    const b = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'B',
    });
    closers.push(() => b.close());
    b.handle('crawl.long', async () => 'from B');

    await until(() => results.length > 0, 5_000);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ stepId: 'hb-run:1', status: 'completed', output: 'from B' });

    // A's abandoned handler finishing later publishes nothing.
    await new Promise((r) => setTimeout(r, 3_200));
    expect(results).toHaveLength(1);
  }, 30_000);
});

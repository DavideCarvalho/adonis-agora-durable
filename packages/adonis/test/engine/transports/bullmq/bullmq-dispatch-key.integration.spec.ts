import { afterAll, describe, expect, it } from 'vitest';
import { DISPATCH_KEY, dispatchKey, type KeyedTask } from '../../../../src/dispatch-key.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps, type RedisLike } from '../../../../src/transports/bullmq/deps.js';
import { tasksName } from '../../../../src/transports/bullmq/naming.js';
import { backendUrl, deleteRedisKeys, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * A step re-sent with the dispatch key of its original dispatch (a crashed turn's step re-dispatched
 * on recovery) must not become a second job while the original still waits or runs: on BullMQ the
 * key becomes the job id, and BullMQ adds nothing for an id it still holds. A task without a key — and
 * a different incarnation of the same step and attempt (a `requeue`d step) — still gets a job of its own.
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

const closers: Array<() => Promise<unknown>> = [];
afterAll(async () => {
  for (const c of closers) await c().catch(() => {});
});

describe.skipIf(!REDIS_URL)('BullMQ task dispatch keys over real Redis', () => {
  const setup = async () => {
    const prefix = uniqueRedisPrefix('durable-dispatch-key');
    const deps = await createBullMQDeps({ url: REDIS_URL } as unknown);
    // No consumer: the jobs stay waiting, like a backlog behind busy workers.
    const transport = new BullMQTransport({ deps, prefix, instanceId: 'engine' });
    const redis = deps.makeRedis() as RedisLike & Parameters<typeof deleteRedisKeys>[0];
    closers.push(
      () => transport.close(),
      async () => {
        await deleteRedisKeys(redis, prefix);
        await (redis as unknown as { quit(): Promise<unknown> }).quit();
      },
    );
    const waiting = async () =>
      Number(
        await (redis as unknown as { llen(k: string): Promise<number> }).llen(
          `bull:${tasksName(prefix, 'jobs.test')}:wait`,
        ),
      );
    return { transport, waiting };
  };

  const task = (key?: string): KeyedTask => ({
    runId: 'r1',
    seq: 0,
    name: 'jobs.test',
    stepId: 'r1:0',
    group: 'jobs.test',
    input: {},
    attempt: 1,
    ...(key !== undefined ? { [DISPATCH_KEY]: key } : {}),
  });

  it('adds one job for two sends of the same dispatch, one per incarnation', async () => {
    const { transport, waiting } = await setup();
    const first = dispatchKey('r1:0', 1, new Date(1_000));
    await transport.dispatch(task(first));
    await transport.dispatch(task(first));
    expect(await waiting()).toBe(1);

    // Same step and attempt, another incarnation (its checkpoint was written again).
    await transport.dispatch(task(dispatchKey('r1:0', 1, new Date(2_000))));
    expect(await waiting()).toBe(2);
  });

  it('refuses a re-send of a dispatch whose job already finished', async () => {
    const prefix = uniqueRedisPrefix('durable-dispatch-key');
    const connection = { url: REDIS_URL } as unknown;
    const engine = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'engine',
    });
    const worker = new BullMQTransport({
      deps: await createBullMQDeps(connection),
      prefix,
      instanceId: 'worker',
    });
    const redis = (await createBullMQDeps(connection)).makeRedis() as RedisLike &
      Parameters<typeof deleteRedisKeys>[0];
    closers.push(
      () => engine.close(),
      () => worker.close(),
      async () => {
        await deleteRedisKeys(redis, prefix);
        await (redis as unknown as { quit(): Promise<unknown> }).quit();
      },
    );
    let runs = 0;
    worker.handle('jobs.test', async () => {
      runs += 1;
      return 'ok';
    });
    const results: unknown[] = [];
    engine.onResult(async (result) => {
      results.push(result);
    });
    const key = dispatchKey('r1:0', 1, new Date(4_000));
    await engine.dispatch(task(key));
    for (let i = 0; i < 500 && results.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(results).toHaveLength(1);
    // The job completed (and is gone); its result may still be on its way to the engine when a
    // recovery re-sends the step. The re-send is refused.
    await engine.dispatch(task(key));
    await new Promise((r) => setTimeout(r, 300));
    expect(runs).toBe(1);
  }, 20_000);

  it('keeps a job per send for an unkeyed task, and dedupes a keyed bulk send too', async () => {
    const { transport, waiting } = await setup();
    await transport.dispatch(task());
    await transport.dispatch(task());
    expect(await waiting()).toBe(2);

    const key = dispatchKey('r1:0', 1, new Date(3_000));
    await transport.dispatchMany([task(key), task(key)]);
    await transport.dispatch(task(key));
    expect(await waiting()).toBe(3);
  });
});

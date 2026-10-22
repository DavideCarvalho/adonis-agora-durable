import { describe, expect, it, vi } from 'vitest';
import { createBullMQDeps, workerConcurrency } from '../../../../src/transports/bullmq/deps.js';

const workerOpts: Array<{ concurrency: number }> = [];

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {
    constructor(_name: string, _process: unknown, opts: { concurrency: number }) {
      workerOpts.push(opts);
    }
  },
}));
vi.mock('ioredis', () => ({ Redis: class {} }));

const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 0.5, -3];

async function concurrencyOf(deps: number | undefined, perWorker?: number): Promise<number> {
  workerOpts.length = 0;
  const built = await createBullMQDeps({ host: '127.0.0.1' }, deps);
  built.makeWorker(
    'q',
    async () => {},
    perWorker === undefined ? undefined : { concurrency: perWorker },
  );
  return workerOpts[0]!.concurrency;
}

describe('BullMQ worker concurrency', () => {
  it('floors a finite value of at least 1 and falls back for anything else', () => {
    expect(workerConcurrency(4)).toBe(4);
    expect(workerConcurrency(2.9)).toBe(2);
    expect(workerConcurrency(undefined)).toBe(1);
    for (const bad of BAD) expect(workerConcurrency(bad), String(bad)).toBe(1);
    expect(workerConcurrency(Number.NaN, 5)).toBe(5);
  });

  it('builds workers at transports.bullmq({ concurrency }), or 1 when it is not usable', async () => {
    expect(await concurrencyOf(6)).toBe(6);
    expect(await concurrencyOf(undefined)).toBe(1);
    for (const bad of BAD) expect(await concurrencyOf(bad), String(bad)).toBe(1);
  });

  it('a per-worker override wins when usable, and falls back to the deps default otherwise', async () => {
    expect(await concurrencyOf(6, 3)).toBe(3);
    for (const bad of BAD) expect(await concurrencyOf(6, bad), String(bad)).toBe(6);
  });
});

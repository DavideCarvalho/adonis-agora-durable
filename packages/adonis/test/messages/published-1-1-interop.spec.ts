import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepResult } from '../../src/interfaces.js';
import { BullMQTransport } from '../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../src/transports/bullmq/deps.js';
import { backendUrl } from '../support/backends.js';

/**
 * This version next to the PUBLISHED 1.1.1 (devDependency `durable-1-1-1`) on one Redis: with the
 * default config this version sends plain, so a 1.1.1 worker runs a step with its real input and a
 * 1.1.1 engine reads this version's results. Sealing is the second step of a rollout, once no 1.1
 * process is left.
 */

const REDIS_URL = backendUrl('DURABLE_REDIS_URL');
const APP_KEY = 'published-interop-app-key-0123456789';

type AnyTransport = {
  handle(name: string, fn: (input: unknown) => Promise<unknown>): void;
  onResult(handler: (r: StepResult) => Promise<void>): void;
  dispatch(task: unknown): Promise<void>;
  close(): Promise<void>;
};

interface Side {
  BullMQTransport: new (options: Record<string, unknown>) => AnyTransport;
  createBullMQDeps: (connection: unknown) => Promise<unknown>;
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => undefined);
});

async function oldSide(): Promise<Side> {
  const old = (await import('durable-1-1-1' as string)) as Side;
  return { BullMQTransport: old.BullMQTransport, createBullMQDeps: old.createBullMQDeps };
}
const newSide: Side = {
  BullMQTransport: BullMQTransport as unknown as Side['BullMQTransport'],
  createBullMQDeps: createBullMQDeps as Side['createBullMQDeps'],
};

async function make(side: Side, prefix: string, extra: Record<string, unknown> = {}) {
  const t = new side.BullMQTransport({
    deps: await side.createBullMQDeps({ url: REDIS_URL }),
    prefix,
    pingIntervalMs: false,
    ...extra,
  });
  closers.push(() => t.close());
  return t;
}

async function until(cond: () => boolean, budgetMs = 15_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > budgetMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const task = (runId: string) => ({
  runId,
  seq: 0,
  stepId: `${runId}:0`,
  name: 'pay',
  group: 'pay',
  input: { amount: 42 },
  attempt: 1,
});

describe.skipIf(!REDIS_URL)('next to the published 1.1.1', () => {
  it('a default-config sender: a 1.1.1 worker runs the step with its real input', async () => {
    const prefix = `dmsg-pub-${randomUUID().slice(0, 8)}`;
    // Default config, with an APP_KEY at hand: still sends plain.
    const engine = await make(newSide, prefix, { messages: { appKey: APP_KEY } });
    const worker = await make(await oldSide(), prefix);
    const seen: unknown[] = [];
    const results: StepResult[] = [];
    worker.handle('pay', async (input) => {
      seen.push(input);
      return { charged: (input as { amount: number }).amount };
    });
    engine.onResult(async (r) => {
      results.push(r);
    });
    await engine.dispatch(task('run-a'));
    await until(() => results.length > 0);
    expect(seen).toEqual([{ amount: 42 }]);
    expect(results[0]).toMatchObject({ status: 'completed', output: { charged: 42 } });
  });

  it('a default-config worker: a 1.1.1 engine reads its results', async () => {
    const prefix = `dmsg-pub-${randomUUID().slice(0, 8)}`;
    const engine = await make(await oldSide(), prefix);
    const worker = await make(newSide, prefix, { messages: { appKey: APP_KEY } });
    const results: StepResult[] = [];
    worker.handle('pay', async (input) => ({ charged: (input as { amount: number }).amount }));
    engine.onResult(async (r) => {
      results.push(r);
    });
    await engine.dispatch(task('run-b'));
    await until(() => results.length > 0);
    expect(results[0]).toMatchObject({ status: 'completed', output: { charged: 42 } });
  });
});

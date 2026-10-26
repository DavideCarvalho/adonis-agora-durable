import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { CodecStateStore } from '../../src/codec-state-store.js';
import type { RemoteTask, StateStore, StepSettlement } from '../../src/interfaces.js';
import { DURABLE_STEP_NAME } from '../../src/step-name-symbol.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';
import { capture, engineOn, ok, PROMPT, STEP, until } from '../support/checkpoint-bytes.js';

/**
 * A step's `input` (an agent's LLM step carries its whole prompt) is written once, when the step is
 * dispatched: settling its result writes only the columns the result changes. The claim, the
 * salvage of a late success and the codec's encoding stay as they are.
 */

const opened: Database[] = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.manager.closeAll();
});

describe.each(dbBackends({ mysql: true }))('on $name', ({ makeStoreDb }) => {
  async function lucid() {
    const db = await makeStoreDb();
    opened.push(db);
    return { store: new LucidStateStore(db), sql: capture(db) };
  }

  it('settling a result writes none of the step input', async () => {
    const { store, sql } = await lucid();
    const { engine, transport } = engineOn(store);
    engine.register('chat', '1', async (ctx) => ctx.step(STEP, { prompt: PROMPT }));
    await startRun(engine, 'chat', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;

    sql.reset();
    await transport.result?.(ok(task));
    await until(async () => (await store.getRun('r1'))?.status === 'completed');

    const writes = sql.checkpointWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(sql.bytesSent(writes)).toBeLessThan(2_000);
    for (const w of writes) expect(w.sql).not.toMatch(/["`]?input["`]?\s*=/i);
    const cp = await store.getCheckpoint('r1', task.seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toEqual({ text: 'hi' });
    expect(cp?.input).toEqual({ prompt: PROMPT });
    sql.stop();
  });

  it('settling a batch of results writes none of their inputs', async () => {
    const { store, sql } = await lucid();
    const { engine, transport } = engineOn(store);
    const prompts = Array.from({ length: 6 }, (_, i) => ({ prompt: `${i}:${PROMPT}` }));
    engine.register('fan', '1', async (ctx) =>
      ctx.all(Object.assign(() => undefined, { [DURABLE_STEP_NAME]: STEP }) as never, prompts),
    );
    await startRun(engine, 'fan', {}, 'f1').catch(() => undefined);
    await until(async () => transport.dispatched.length === prompts.length);
    await until(async () => (await store.getRun('f1'))?.status === 'suspended');

    sql.reset();
    await Promise.all(transport.dispatched.map((t, i) => transport.result?.(ok(t, i))));
    await until(async () => (await store.getRun('f1'))?.status === 'completed');

    const writes = sql.checkpointWrites();
    expect(writes.length).toBeGreaterThan(0);
    expect(sql.bytesSent(writes)).toBeLessThan(5_000);
    expect((await store.getRun('f1'))?.output).toEqual([0, 1, 2, 3, 4, 5]);
    const cps = await store.listCheckpoints('f1');
    expect(cps.filter((c) => c.kind === 'remote').map((c) => c.input)).toEqual(prompts);
    sql.stop();
  });

  it('a duplicate delivery still loses the claim', async () => {
    const { store } = await lucid();
    const { engine, transport } = engineOn(store);
    const completed: number[] = [];
    engine.subscribe((e) => {
      if (e.type === 'step.completed' && e.seq !== undefined) completed.push(e.seq);
    });
    engine.register('chat', '1', async (ctx) => ctx.step(STEP, { prompt: PROMPT }));
    await startRun(engine, 'chat', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    await Promise.all([transport.result?.(ok(task, 'first')), transport.result?.(ok(task, 'dup'))]);
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(completed).toEqual([task.seq]);
    const output = (await store.getCheckpoint('r1', task.seq))?.output;
    expect(['first', 'dup']).toContain(output);
    expect((await store.getRun('r1'))?.output).toBe(output);
  });

  it('a late success for a failed run is salvaged onto its step, input kept', async () => {
    const { store, sql } = await lucid();
    const { engine, transport } = engineOn(store);
    engine.register('chat', '1', async (ctx) => ctx.step(STEP, { prompt: PROMPT }));
    await startRun(engine, 'chat', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    await store.updateRun('r1', { status: 'failed', updatedAt: new Date() });

    sql.reset();
    await transport.result?.(ok(task, 'late'));
    const cp = await store.getCheckpoint('r1', task.seq);
    expect(cp?.status).toBe('completed');
    expect(cp?.output).toBe('late');
    expect(cp?.input).toEqual({ prompt: PROMPT });
    expect((await store.getRun('r1'))?.status).toBe('failed');
    expect(sql.bytesSent(sql.checkpointWrites())).toBeLessThan(2_000);
    sql.stop();
  });
});

describe('CodecStateStore settleCheckpointsIfPending', () => {
  const codec = {
    encode: (v: unknown) => ({ enc: JSON.stringify(v) }),
    decode: (v: unknown) => JSON.parse((v as { enc: string }).enc),
  };
  const settlement: StepSettlement = {
    runId: 'r1',
    seq: 0,
    status: 'completed',
    output: { text: 'secret' },
    events: [{ at: 1, level: 'info', message: 'logged' }],
    startedAt: new Date(1),
    finishedAt: new Date(2),
  };

  it('encodes the output, and the events under extended coverage', async () => {
    for (const coverage of ['payloads', 'extended'] as const) {
      const inner = new InMemoryStateStore();
      const received: StepSettlement[] = [];
      const settle = inner.settleCheckpointsIfPending.bind(inner);
      inner.settleCheckpointsIfPending = async (s) => {
        received.push(...s);
        return settle(s);
      };
      const store = new CodecStateStore(inner, codec, { coverage });
      await store.saveCheckpoint({
        runId: 'r1',
        seq: 0,
        name: STEP,
        kind: 'remote',
        stepId: 'r1:0',
        status: 'pending',
        input: { prompt: 'p' },
        attempts: 1,
        enqueuedAt: new Date(0),
        startedAt: new Date(0),
        finishedAt: new Date(0),
      });
      expect(await store.settleCheckpointsIfPending?.([settlement])).toEqual([true]);
      expect(received[0]?.output).toEqual({ enc: JSON.stringify({ text: 'secret' }) });
      expect(received[0]?.events).toEqual(
        coverage === 'extended'
          ? { enc: JSON.stringify([{ at: 1, level: 'info', message: 'logged' }]) }
          : [{ at: 1, level: 'info', message: 'logged' }],
      );
      const read = await store.getCheckpoint('r1', 0);
      expect(read?.output).toEqual({ text: 'secret' });
      expect(read?.input).toEqual({ prompt: 'p' });
    }
  });

  it('is absent when the inner store lacks it', () => {
    const inner = Object.create(new InMemoryStateStore(), {
      settleCheckpointsIfPending: { value: undefined },
    }) as StateStore;
    expect(new CodecStateStore(inner, codec).settleCheckpointsIfPending).toBeUndefined();
  });
});

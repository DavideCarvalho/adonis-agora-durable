import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { CodecStateStore } from '../../src/codec-state-store.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { RemoteTask, StateStore } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';
import {
  capture,
  engineOn,
  HeldTransport,
  ok,
  PROMPT,
  STEP,
  until,
} from '../support/checkpoint-bytes.js';

/**
 * A turn's replay reads no completed step's `input`: replaying it needs only its output. Everything
 * that needs an input still has it: a re-dispatch of a pending step, a retry of a failed one, and
 * the run detail.
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

  it('a resume reads no completed step input, and the run detail still shows it', async () => {
    const { store, sql } = await lucid();
    const { engine, transport } = engineOn(store);
    engine.register('chat', '1', async (ctx) => {
      const first = await ctx.step(STEP, { prompt: PROMPT });
      return ctx.step(STEP, { prompt: 'short', after: first });
    });
    await startRun(engine, 'chat', {}, 'r1');
    await transport.result?.(ok(transport.dispatched[0] as RemoteTask, 'one'));
    await until(async () => transport.dispatched.length === 2);
    await until(async () => (await store.getRun('r1'))?.status === 'suspended');

    // The second result's settle and the resume it drives: the first step is replayed from its
    // output alone.
    sql.reset();
    await transport.result?.(ok(transport.dispatched[1] as RemoteTask, 'two'));
    await until(async () => (await store.getRun('r1'))?.status === 'completed');
    expect(sql.bytesRead()).toBeLessThan(20_000);
    expect((await store.getRun('r1'))?.output).toBe('two');

    const detail = await engine.listCheckpoints('r1');
    expect(detail.map((c) => c.input)).toEqual([
      { prompt: PROMPT },
      { prompt: 'short', after: 'one' },
    ]);
    sql.stop();
  });

  it('a pending step whose dispatch was lost is re-dispatched with its input', async () => {
    const { store } = await lucid();
    let now = 1_000_000;
    const { engine, transport } = engineOn(store, { clock: () => now, redispatchMs: 60_000 });
    engine.register('chat', '1', async (ctx) => {
      await ctx.step(STEP, { prompt: 'done first' });
      return ctx.step(STEP, { prompt: PROMPT });
    });
    await startRun(engine, 'chat', {}, 'r1');
    await transport.result?.(ok(transport.dispatched[0] as RemoteTask, 'one'));
    await until(async () => transport.dispatched.length === 2);
    // The turn that sees it pending stamps its lease; past the lease it is sent again.
    await until(async () => (await store.getRun('r1'))?.status === 'suspended');
    await until(async () => {
      now += 120_000;
      await engine.runOne('r1');
      return transport.dispatched.length > 2;
    });
    const resent = transport.dispatched.slice(2);
    expect(resent.length).toBeGreaterThan(0);
    expect(resent[0]?.input).toEqual({ prompt: PROMPT });
  });

  it('a failed step retried from the replay keeps its input', async () => {
    const { store } = await lucid();
    let now = 1_000_000;
    const { engine, transport } = engineOn(store, { clock: () => now });
    engine.register('chat', '1', async (ctx) =>
      ctx.step(STEP, { prompt: PROMPT }, { retries: 2, backoffMs: 1_000 }),
    );
    await startRun(engine, 'chat', {}, 'r1');
    const task = transport.dispatched[0] as RemoteTask;
    await transport.result?.({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      status: 'failed',
      error: { message: 'rate limited' },
    });
    await until(async () => (await store.getCheckpoint('r1', task.seq))?.wakeAt != null);
    await until(async () => {
      now += 10_000;
      await engine.runOne('r1');
      return transport.dispatched.length === 2;
    });
    expect(transport.dispatched[1]?.input).toEqual({ prompt: PROMPT });
    expect((await store.getCheckpoint('r1', task.seq))?.input).toEqual({ prompt: PROMPT });
  });
});

describe('the engine reads a turn through listCheckpointsForReplay', () => {
  it('reads the replay snapshot without inputs, and falls back to listCheckpoints', async () => {
    for (const hasReplayRead of [true, false]) {
      const inner = new InMemoryStateStore();
      const calls = { replay: 0, list: 0 };
      const store = Object.create(inner) as StateStore;
      store.listCheckpoints = async (runId) => {
        calls.list += 1;
        return inner.listCheckpoints(runId);
      };
      Object.defineProperty(store, 'listCheckpointsForReplay', {
        value: hasReplayRead
          ? async (runId: string) => {
              calls.replay += 1;
              return inner.listCheckpointsForReplay(runId);
            }
          : undefined,
      });
      const transport = new HeldTransport();
      const engine = new WorkflowEngine({ store, transports: [{ id: 't', transport }] });
      engine.register('chat', '1', async (ctx) => ctx.step(STEP, { prompt: 'p' }));
      await startRun(engine, 'chat', {}, 'r1');
      await transport.result?.(ok(transport.dispatched[0] as RemoteTask));
      await until(async () => (await inner.getRun('r1'))?.status === 'completed');
      if (hasReplayRead) {
        expect(calls.replay).toBeGreaterThanOrEqual(2);
        expect(calls.list).toBe(0);
      } else {
        expect(calls.list).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('CodecStateStore listCheckpointsForReplay', () => {
  const codec = {
    encode: (v: unknown) => ({ enc: JSON.stringify(v) }),
    decode: (v: unknown) => JSON.parse((v as { enc: string }).enc),
  };

  it('decodes the rows it reads', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, codec);
    const at = new Date(0);
    const row = { runId: 'r1', name: STEP, kind: 'remote' as const, attempts: 1 };
    await store.saveCheckpoint({
      ...row,
      seq: 0,
      stepId: 'r1:0',
      status: 'completed',
      input: { prompt: 'p0' },
      output: { text: 'secret' },
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
    await store.saveCheckpoint({
      ...row,
      seq: 1,
      stepId: 'r1:1',
      status: 'pending',
      input: { prompt: 'p1' },
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
    const replayed = (await store.listCheckpointsForReplay?.('r1')) ?? [];
    expect(replayed.map((c) => [c.output, c.input])).toEqual([
      [{ text: 'secret' }, undefined],
      [undefined, { prompt: 'p1' }],
    ]);
  });

  it('is absent when the inner store lacks it', () => {
    const inner = Object.create(new InMemoryStateStore(), {
      listCheckpointsForReplay: { value: undefined },
    }) as StateStore;
    expect(new CodecStateStore(inner, codec).listCheckpointsForReplay).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { CodecStateStore, type PayloadCodec } from '../../src/codec-state-store.js';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

// A reversible codec that wraps the value so we can prove it was applied at rest.
const wrapCodec: PayloadCodec = {
  encode: (v) => (v === undefined ? undefined : { __enc: JSON.stringify(v) }),
  decode: (v) =>
    v && typeof v === 'object' && '__enc' in v ? JSON.parse((v as { __enc: string }).__enc) : v,
};

describe('CodecStateStore', () => {
  it('forwards the pending-only checkpoint write, encoding it like a plain save', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, wrapCodec);
    const at = new Date();
    const pending = {
      runId: 'r1',
      seq: 0,
      name: 'charge',
      kind: 'remote' as const,
      stepId: 'r1:0',
      status: 'pending' as const,
      input: { card: '4242' },
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    };
    await store.saveCheckpoint(pending);

    const done = { ...pending, status: 'completed' as const, output: { id: 'ch_1' } };
    expect(await store.saveCheckpointIfPending?.(done)).toBe(true);
    expect((await inner.getCheckpoint('r1', 0))?.output).toEqual({
      __enc: JSON.stringify({ id: 'ch_1' }),
    });
    expect(await store.saveCheckpointIfPending?.(pending)).toBe(false);

    Object.defineProperty(inner, 'saveCheckpointIfPending', { value: undefined });
    expect(new CodecStateStore(inner, wrapCodec).saveCheckpointIfPending).toBeUndefined();
  });

  it('forwards countCheckpoints only when the inner store has it', async () => {
    const inner = new InMemoryStateStore();
    const at = new Date();
    await inner.saveCheckpoint({
      runId: 'r1',
      seq: 3,
      name: 'charge',
      kind: 'remote',
      stepId: 'r1:3',
      status: 'pending',
      attempts: 1,
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
    expect(
      await new CodecStateStore(inner, wrapCodec).countCheckpoints?.('r1', 0, 9, ['pending']),
    ).toBe(1);

    Object.defineProperty(inner, 'countCheckpoints', { value: undefined });
    expect(new CodecStateStore(inner, wrapCodec).countCheckpoints).toBeUndefined();
  });

  it('encodes payloads at rest and decodes them on read', async () => {
    const inner = new InMemoryStateStore();
    const store = new CodecStateStore(inner, wrapCodec);
    const now = new Date();
    await store.createRun({
      id: 'r1',
      workflow: 'wf',
      workflowVersion: '1',
      status: 'completed',
      input: { secret: 'ssn-123' },
      output: { ok: true },
      createdAt: now,
      updatedAt: now,
    });

    // At rest (inner store) the payload is encoded…
    const raw = await inner.getRun('r1');
    expect(raw?.input).toEqual({ __enc: JSON.stringify({ secret: 'ssn-123' }) });
    // …and reading through the codec decodes it.
    const got = await store.getRun('r1');
    expect(got?.input).toEqual({ secret: 'ssn-123' });
    expect(got?.output).toEqual({ ok: true });
  });

  it('runs a workflow end-to-end through the codec (step outputs encoded at rest)', async () => {
    const inner = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store: new CodecStateStore(inner, wrapCodec) });
    engine.register('wf', '1', async (ctx, input) => {
      const a = await ctx.localStep('a', async () => ({ doubled: (input as { n: number }).n * 2 }));
      return a;
    });

    const res = await startRun(engine, 'wf', { n: 21 }, 'r2');
    expect(res.status).toBe('completed');
    expect(res.output).toEqual({ doubled: 42 });
    // The checkpoint's output is encoded in the underlying store.
    const cp = await inner.getCheckpoint('r2', 0);
    expect(cp?.output).toHaveProperty('__enc');
  });
});

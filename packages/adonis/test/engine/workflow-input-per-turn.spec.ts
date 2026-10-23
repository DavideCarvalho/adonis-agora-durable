import type { Database } from '@adonisjs/lucid/database';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowEngine } from '../../src/engine.js';
import type { StateStore, WorkflowDecision, WorkflowRun } from '../../src/interfaces.js';
import { LucidStateStore } from '../../src/stores/lucid.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { dbBackends } from '../support/backends.js';

/**
 * `inputSchema` stores the input AS SENT and hands every turn the parsed value. Run against the
 * in-memory store AND a real Lucid database on purpose: the in-memory store copies a row with a
 * structured clone, which keeps a `Date` a `Date`, while a SQL store round-trips it through a JSON
 * column, which turns it into a string. Storing the parsed value passed on the first and broke on
 * the second — the body received a string its schema had typed as a `Date`.
 */
interface Backend {
  name: string;
  make(): Promise<{ store: StateStore; close: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: 'in-memory',
    make: async () => ({ store: new InMemoryStateStore(), close: async () => {} }),
  },
  ...dbBackends().map(
    (b): Backend => ({
      name: `lucid on ${b.name}`,
      make: async () => {
        const db: Database = await b.makeStoreDb();
        return { store: new LucidStateStore(db), close: () => db.manager.closeAll() };
      },
    }),
  ),
];

const orderInput = z.object({ orderId: z.string(), placedAt: z.coerce.date() });

describe.each(backends)('workflow inputSchema, parsed per turn, on $name', (backend) => {
  let store: StateStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ store, close } = await backend.make());
  });
  afterEach(async () => {
    await close();
  });

  it('stores the input as sent and hands every turn — the replay too — the parsed value', async () => {
    const engine = new WorkflowEngine({ store });
    const seen: unknown[] = [];
    engine.register(
      'order',
      '1',
      async (ctx, input) => {
        const { orderId, placedAt } = input as z.infer<typeof orderInput>;
        seen.push(placedAt);
        await ctx.waitForSignal(`paid:${orderId}`);
        return placedAt.toISOString();
      },
      { inputSchema: orderInput },
    );

    await engine.start('order', { orderId: 'o1', placedAt: '2026-01-02T03:04:05.000Z' }, 'r1');
    expect((await engine.waitForRun('r1')).status).toBe('suspended');
    await engine.signal('paid:o1', {});
    const result = await engine.waitForRun('r1', { terminal: true });

    expect(result).toMatchObject({ status: 'completed', output: '2026-01-02T03:04:05.000Z' });
    expect((await store.getRun('r1'))?.input).toEqual({
      orderId: 'o1',
      placedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(seen).toHaveLength(2);
    for (const placedAt of seen) expect(placedAt).toBeInstanceOf(Date);
  });

  it('fails a run whose stored input no longer parses, with schema_validation', async () => {
    const engine = new WorkflowEngine({ store });
    engine.register(
      'order',
      '1',
      async (ctx, input) => {
        await ctx.waitForSignal(`paid:${(input as { orderId: string }).orderId}`);
        return 'ok';
      },
      { inputSchema: orderInput },
    );

    await engine.start('order', { orderId: 'o2', placedAt: '2026-01-02T03:04:05.000Z' }, 'r2');
    await engine.waitForRun('r2');
    // As if the schema had changed under an in-flight run without a version bump.
    await store.updateRun('r2', { input: { orderId: 'o2', placedAt: 'not a date' } });
    await engine.signal('paid:o2', {});
    const result = await engine.waitForRun('r2', { terminal: true });

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'schema_validation' });
  });
});

describe('workflow inputSchema on a remote workflow', () => {
  it('sends the parsed input in the task and keeps the input as sent on the run', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const taskInputs: unknown[] = [];
    engine.registerRemote('py', '1', {
      group: 'py',
      executor: {
        advance: async (run: WorkflowRun): Promise<WorkflowDecision> => {
          taskInputs.push(run.input);
          return { taskId: 't', runId: run.id, status: 'completed', commands: [], output: 'done' };
        },
      },
      inputSchema: v.object({ qty: v.pipe(v.string(), v.transform(Number)) }),
    });

    await engine.start('py', { qty: '3' }, 'p1');
    const result = await engine.waitForRun('p1', { terminal: true });

    expect(result.status).toBe('completed');
    expect(taskInputs).toEqual([{ qty: 3 }]);
    expect((await store.getRun('p1'))?.input).toEqual({ qty: '3' });
  });

  it('fails the run instead of dispatching when the stored input no longer parses', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let advanced = 0;
    engine.registerRemote('py', '1', {
      group: 'py',
      executor: {
        advance: async (run: WorkflowRun): Promise<WorkflowDecision> => {
          advanced += 1;
          return { taskId: 't', runId: run.id, status: 'continue', commands: [] };
        },
      },
      inputSchema: v.object({ qty: v.string() }),
    });
    // A row whose input the schema rejects, written directly: `start` itself would refuse it.
    const at = new Date();
    await store.createRun({
      id: 'p2',
      workflow: 'py',
      workflowVersion: '1',
      status: 'pending',
      input: { qty: 3 },
      createdAt: at,
      updatedAt: at,
    });
    await engine.runPending();
    const result = await engine.waitForRun('p2', { terminal: true });

    expect(advanced).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'schema_validation' });
  });
});

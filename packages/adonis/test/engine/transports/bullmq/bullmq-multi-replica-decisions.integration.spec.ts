import { afterAll, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../../src/engine.js';
import type { WorkflowRun } from '../../../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../../../src/remote-workflow-executor.js';
import { InMemoryStateStore } from '../../../../src/testing/in-memory-state-store.js';
import { BullMQTransport } from '../../../../src/transports/bullmq/bullmq-transport.js';
import { createBullMQDeps } from '../../../../src/transports/bullmq/deps.js';
import { backendUrl, uniqueRedisPrefix } from '../../../support/backends.js';

/**
 * Two engine replicas on one real Redis: `${P}-decisions` is ONE BullMQ queue both replicas' workers
 * compete on, so roughly half of the decisions of the turns replica A dispatches are taken by
 * replica B. Every run must still complete. Gated on `DURABLE_REDIS_URL`, like the other real-Redis
 * specs:
 *
 *   DURABLE_REDIS_URL=redis://localhost:6379 node_modules/.bin/vitest run bullmq-multi-replica
 */
const REDIS_URL = backendUrl('DURABLE_REDIS_URL');

const closers: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of closers) await c().catch(() => {});
});

async function settle(store: InMemoryStateStore, ids: string[]): Promise<WorkflowRun[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const runs = (await Promise.all(ids.map((id) => store.getRun(id)))) as WorkflowRun[];
    if (runs.every((r) => r?.status === 'completed') || Date.now() > deadline) return runs;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!REDIS_URL)('BullMQ: remote workflow decisions across two engine replicas', () => {
  it('completes every run whichever replica consumes its decision', async () => {
    const prefix = uniqueRedisPrefix('durable-it-decisions');
    const connection = { url: REDIS_URL } as unknown;
    const transport = async (instanceId: string) => {
      const t = new BullMQTransport({
        deps: await createBullMQDeps(connection),
        prefix,
        instanceId,
      });
      closers.push(() => t.close());
      return t;
    };

    const worker = await transport('wf-worker');
    worker.handleWorkflow('proc', async (task) => ({
      taskId: task.taskId,
      runId: task.runId,
      status: 'completed',
      commands: [],
      output: { done: task.runId },
    }));

    const store = new InMemoryStateStore();
    const replicas = await Promise.all(
      ['A', 'B'].map(async (name) => {
        const t = await transport(`engine-${name}`);
        const engine = new WorkflowEngine({ store, transport: t, instanceId: name });
        engine.registerRemote('proc', '1', {
          group: 'proc',
          executor: new RemoteWorkflowExecutor(t, 'proc'),
        });
        return engine;
      }),
    );
    const [a, b] = replicas as [WorkflowEngine, WorkflowEngine];

    // Both replicas have driven a turn, so both consume `${P}-decisions`.
    await b.start('proc', {}, 'warm');
    expect((await settle(store, ['warm']))[0]?.status).toBe('completed');

    const ids = Array.from({ length: 20 }, (_, i) => `run-${i}`);
    for (const id of ids) await a.start('proc', {}, id);
    const runs = await settle(store, ids);

    expect(runs.map((r) => r?.status)).toEqual(ids.map(() => 'completed'));
    expect(runs.map((r) => r?.output)).toEqual(ids.map((id) => ({ done: id })));
  }, 30_000);
});

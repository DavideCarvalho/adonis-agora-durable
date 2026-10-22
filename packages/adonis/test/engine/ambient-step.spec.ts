import { describe, expect, it } from 'vitest';
import { currentStep, InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import type { RemoteTask } from '../../src/interfaces.js';
import { runStepHandler } from '../../src/protocol.js';

/** `currentStep()`: the step logger, reachable from code that was never handed it. */

/** A helper several calls below a step body, which takes no logger. */
async function deepHelper(rows: number): Promise<number> {
  await Promise.resolve();
  currentStep()?.info('inserted batch', { rows });
  return rows;
}

describe('currentStep()', () => {
  it('is undefined outside a step, so instrumented helpers still run', async () => {
    expect(currentStep()).toBeUndefined();
    await expect(deepHelper(3)).resolves.toBe(3);
  });

  it('records into the local step’s own event list, next to what the argument logger wrote', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('etl', '1', async (ctx) =>
      ctx.localStep('load', async (log) => {
        log.info('start');
        return deepHelper(12);
      }),
    );
    await engine.start('etl', {}, 'r1');
    await engine.waitForRun('r1');
    const cp = (await store.listCheckpoints('r1')).find((c) => c.name === 'load');
    expect(cp?.events?.map((e) => e.message)).toEqual(['start', 'inserted batch']);
    expect(cp?.events?.[1]?.data).toEqual({ rows: 12 });
  });

  it('keeps concurrent steps apart', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('fan', '1', async (ctx) => {
      await Promise.all([
        ctx.localStep('a', async () => {
          await new Promise((r) => setTimeout(r, 5));
          return deepHelper(1);
        }),
        ctx.localStep('b', async () => deepHelper(2)),
      ]);
    });
    await engine.start('fan', {}, 'r2');
    await engine.waitForRun('r2');
    const cps = await store.listCheckpoints('r2');
    expect(cps.find((c) => c.name === 'a')?.events?.map((e) => e.data)).toEqual([{ rows: 1 }]);
    expect(cps.find((c) => c.name === 'b')?.events?.map((e) => e.data)).toEqual([{ rows: 2 }]);
  });

  it('is installed around a remote step handler on a worker too', async () => {
    const task: RemoteTask = {
      runId: 'r',
      seq: 0,
      stepId: 'r:0',
      name: 'load',
      group: 'load',
      input: 5,
      attempt: 0,
    };
    const result = await runStepHandler(task, async (input) => deepHelper(input as number));
    expect(result.status).toBe('completed');
    expect(result.events?.map((e) => e.message)).toEqual(['inserted batch']);
  });
});

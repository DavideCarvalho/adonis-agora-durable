import { InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import { assertReplayable, type RunHistory } from '../../src/testing-kit/replay.js';

// Capture a real run's history the way a CI fixture would.
async function recordHistory(register: (e: WorkflowEngine) => void): Promise<RunHistory> {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  register(engine);
  await engine.start('wf', {}, 'run1');
  await engine.waitForRun('run1'); // execute (dispatch model) until it suspends mid-way
  const run = await store.getRun('run1');
  if (!run) throw new Error('no run');
  return { run, checkpoints: await store.listCheckpoints('run1') };
}

const v1 = (e: WorkflowEngine) =>
  e.register('wf', '1', async (ctx) => {
    await ctx.localStep('a', async () => 1);
    await ctx.waitForSignal('go');
    await ctx.localStep('b', async () => 2);
  });

describe('assertReplayable', () => {
  it('passes when the workflow code is unchanged', async () => {
    const history = await recordHistory(v1);
    await expect(assertReplayable(v1, history)).resolves.toBeUndefined();
  });

  it('throws when a step was renamed/reordered under the recorded history', async () => {
    const history = await recordHistory(v1);
    const changed = (e: WorkflowEngine) =>
      e.register('wf', '1', async (ctx) => {
        await ctx.localStep('renamed', async () => 1); // seq 0 was "a" in the history
        await ctx.waitForSignal('go');
        await ctx.localStep('b', async () => 2);
      });
    await expect(assertReplayable(changed, history)).rejects.toThrow(/non-determinism/);
  });
});

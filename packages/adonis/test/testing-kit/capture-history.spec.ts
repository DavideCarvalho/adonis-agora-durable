import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { assertReplayable, captureHistory, parseRunHistory } from '../../src/testing-kit/replay.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

describe('captureHistory → JSON fixture → assertReplayable (the durable:export loop)', () => {
  it('round-trips through JSON with Dates revived, and replays clean against unchanged code', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const body = async (ctx: Parameters<Parameters<WorkflowEngine['register']>[2]>[0]) => {
      const a = await ctx.localStep('a', async () => 2);
      const b = await ctx.localStep('b', async () => 3);
      return a * b;
    };
    engine.register('math', '1', body);
    await engine.start('math', {}, 'r1');
    await flush();

    const history = await captureHistory(engine, 'r1');
    expect(history?.checkpoints.length).toBeGreaterThan(0);
    const fixture = parseRunHistory(JSON.stringify(history));
    expect(fixture.run.createdAt).toBeInstanceOf(Date);
    expect(fixture.checkpoints[0]?.startedAt).toBeInstanceOf(Date);

    // Unchanged code replays clean.
    await assertReplayable((e) => e.register('math', '1', body), fixture);

    // A reordered/renamed step at a recorded position fails loudly.
    await expect(
      assertReplayable(
        (e) =>
          e.register('math', '1', async (ctx) => {
            await ctx.localStep('renamed', async () => 2);
            return 0;
          }),
        fixture,
      ),
    ).rejects.toThrow(/non-determinism/i);
  });

  it('captureHistory returns null for an unknown run', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    expect(await captureHistory(engine, 'nope')).toBeNull();
  });
});

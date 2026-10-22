import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

describe('in-flight tracking never creates an unhandled rejection', () => {
  it('a turn that fails on a store outage rejects for its caller only', async () => {
    const store = new InMemoryStateStore();
    const outage = new Error('checkpoint connection lost');
    const engine = new WorkflowEngine({ store, runDispatcher: { dispatch: () => {} } });
    engine.register('job', '1', async () => 'done');
    await engine.start('job', {}, 'run');
    vi.spyOn(store, 'listCheckpoints').mockRejectedValue(outage);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(engine.runOne('run')).rejects.toBe(outage);
      await expect(engine.drain()).resolves.toBeUndefined();
      await setImmediate();
      await setImmediate();
      expect(unhandled).not.toHaveBeenCalled();
      expect((engine as unknown as { inflight: Map<unknown, string> }).inflight.size).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

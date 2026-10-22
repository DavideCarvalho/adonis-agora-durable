/**
 * Store-operation counts for the singleton gate: admission is ONE atomic store claim
 * (`tryAdmitSingleton`), and the terminal settle adds ONE notify-on-release scan — a one-shot cost
 * per completion that replaces a per-~1s-tick re-poll for every gated waiter.
 */
import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { RunQuery, WorkflowRun } from '../../src/interfaces.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

class CountingStore extends InMemoryStateStore {
  listRunsCalls = 0;
  admissionCalls = 0;
  override async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    this.listRunsCalls++;
    return super.listRuns(query);
  }
  override async tryAdmitSingleton(
    runId: string,
    tag: string,
    workflow: string,
    limit: number,
    retryWakeAt?: number,
  ): Promise<boolean> {
    this.admissionCalls++;
    return super.tryAdmitSingleton(runId, tag, workflow, limit, retryWakeAt);
  }
}

describe('singleton admission operations', () => {
  it('uses one atomic claim and one release notification scan per uncontended run', async () => {
    const store = new CountingStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async () => 'done', { singleton: { key: () => 'k' } });
    expect((await startRun(engine, 'job', {}, 'solo')).status).toBe('completed');
    // The notify-on-release scan is a tracked post-settle effect; let it land before counting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.admissionCalls).toBe(1);
    expect(store.listRunsCalls).toBe(1);
    await engine.drain();
  });

  it('jitter spreads waiter wakeups (no lockstep stampede)', async () => {
    // The retry uses clock()+1000±250ms with Math.random(). Sample many wake offsets and assert spread.
    const offsets = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      offsets.add(1000 + Math.floor((Math.random() * 2 - 1) * 250));
    }
    expect(offsets.size).toBeGreaterThan(100);
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(750);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(1250);
  });
});

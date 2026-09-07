import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A transport under full manual control: dispatch parks the task; the test never replies. */
class ManualTransport {
  readonly tasks: RemoteTask[] = [];
  #onResult?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.tasks.push(task);
  }
  onResult(h: (r: StepResult) => Promise<void>): void {
    this.#onResult = h;
  }
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {
    // No consumer: this test never replies, so no heartbeat can arrive; the
    // member exists only to satisfy the transport interface.
  }
  async reply(r: StepResult): Promise<void> {
    await this.#onResult?.(r);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, budgetMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

describe('drain releases in-flight run leases for fast handoff', () => {
  it('drain() releases the lock of a run stuck awaiting a remote result (timeout path)', async () => {
    const store = new InMemoryStateStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({ store, transport: transport as never });
    engine.register('harvest', '1', async (ctx) => {
      await ctx.step('lote', {}, { timeoutMs: 600_000, retries: 1 });
      return 'done';
    });

    await engine.start('harvest', {}, 'run-drain-release');
    await until(() => transport.tasks.length === 1);

    // The turn is stuck in-memory awaiting the remote result: the run is locked by this engine.
    const before = await store.getRun('run-drain-release');
    expect(before?.status).toBe('running');
    expect(before?.lockedBy).toBeTruthy();
    const nowBefore = Date.now();
    expect(
      await store.tryLockRun('run-drain-release', 'other', nowBefore + 30_000, nowBefore),
    ).toBe(false);

    // Short timeout forces the timeout path while the step is still pending.
    await engine.drain(50);

    // The lease is released, so the next pod reclaims in seconds instead of after lease expiry.
    const nowAfter = Date.now();
    expect(await store.tryLockRun('run-drain-release', 'other', nowAfter + 30_000, nowAfter)).toBe(
      true,
    );
  });

  it('drain() on an idle engine resolves promptly', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const t0 = Date.now();
    await engine.drain(50);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

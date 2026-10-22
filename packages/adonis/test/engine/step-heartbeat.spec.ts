import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { EventEmitterTransport } from '../../src/transports/event-emitter.js';

/** Wait until `cond()` is true (heartbeat persistence is fire-and-forget) or fail after a budget. */
async function until(cond: () => boolean | Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > budgetMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The full liveness lane, end to end: a remote step handler calls `log.heartbeat(progress)` →
 * the transport carries the beat → the engine persists it on the step's checkpoint — so a status
 * surface in ANOTHER process can tell "alive mid-flight" from "hung" without domain tables.
 */
describe('step heartbeat: handler → transport → checkpoint', () => {
  it('persists the latest beat (with progress) on the pending remote checkpoint', async () => {
    const store = new InMemoryStateStore();
    const transport = new EventEmitterTransport();
    const engine = new WorkflowEngine({ store, transport });

    // The handler beats, then WAITS until the test releases it — freezing the step mid-flight so
    // the assertion reads the checkpoint of a genuinely in-progress step, not a settled one.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    transport.handle('lote.colher', async (_input, log) => {
      log.heartbeat({ done: 12, total: 50 });
      await gate;
      return 'ok';
    });

    engine.register('harvest', '1', async (ctx) => {
      // timeoutMs → in-memory await path, the long-step shape heartbeats exist for.
      await ctx.step('lote.colher', { lote: 1 }, { timeoutMs: 60_000 });
      return 'done';
    });

    await engine.start('harvest', {}, 'run-hb');
    await until(async () => {
      const cps = await store.listCheckpoints('run-hb');
      return cps.some((cp) => cp.lastHeartbeatAt !== undefined);
    });

    const cp = (await store.listCheckpoints('run-hb')).find((c) => c.name === 'lote.colher');
    expect(cp?.status).toBe('pending');
    expect(cp?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(cp?.heartbeatProgress).toEqual({ done: 12, total: 50 });

    release();
    const final = await engine.waitForRun('run-hb', { terminal: true });
    expect(final.status).toBe('completed');
  });

  it('a handler that never beats manually still gets a PICKUP beat persisted', async () => {
    const store = new InMemoryStateStore();
    const transport = new EventEmitterTransport();
    const engine = new WorkflowEngine({ store, transport });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // No log.heartbeat anywhere — the automatic pickup beat is the only signal.
    transport.handle('lote.mudo', async () => {
      await gate;
      return 'ok';
    });
    engine.register('harvest', '1', async (ctx) => {
      await ctx.step('lote.mudo', {}, { timeoutMs: 60_000 });
      return 'done';
    });

    await engine.start('harvest', {}, 'run-pickup');
    await until(async () => {
      const cp = (await store.listCheckpoints('run-pickup')).find((c) => c.name === 'lote.mudo');
      return cp?.lastHeartbeatAt !== undefined;
    });

    const cp = (await store.listCheckpoints('run-pickup')).find((c) => c.name === 'lote.mudo');
    // "Queued" vs "executing" is now visible for EVERY remote step, not just beating ones.
    expect(cp?.status).toBe('pending');
    expect(cp?.lastHeartbeatAt).toBeInstanceOf(Date);

    release();
    const final = await engine.waitForRun('run-pickup', { terminal: true });
    expect(final.status).toBe('completed');
  });
});

/** A transport under full manual control: dispatch parks the task; the test decides when the
 *  "worker" beats or replies. No poll loops — pure engine-side timing semantics. */
class ManualTransport {
  readonly tasks: import('../../src/interfaces.js').RemoteTask[] = [];
  #onResult?: (r: import('../../src/interfaces.js').StepResult) => Promise<void>;
  #onHeartbeat?: (b: import('../../src/interfaces.js').Heartbeat) => Promise<void>;
  async dispatch(task: import('../../src/interfaces.js').RemoteTask): Promise<void> {
    this.tasks.push(task);
  }
  onResult(h: (r: import('../../src/interfaces.js').StepResult) => Promise<void>): void {
    this.#onResult = h;
  }
  onHeartbeat(h: (b: import('../../src/interfaces.js').Heartbeat) => Promise<void>): void {
    this.#onHeartbeat = h;
  }
  async beat(b: import('../../src/interfaces.js').Heartbeat): Promise<void> {
    await this.#onHeartbeat?.(b);
  }
  async reply(r: import('../../src/interfaces.js').StepResult): Promise<void> {
    await this.#onResult?.(r);
  }
}

describe('pickupTimeoutMs: queue wait is not silence', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('outlives timeoutMs while unclaimed, then the pickup beat hands over to the tighter window', async () => {
    const store = new InMemoryStateStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({ store, transport: transport as never });

    engine.register('harvest', '1', async (ctx) => {
      // timeoutMs alone would have failed this dispatch during the queue wait below; the split
      // window is exactly what tolerates a busy single-concurrency worker.
      await ctx.step('lote', {}, { timeoutMs: 100, pickupTimeoutMs: 10_000, retries: 1 });
      return 'done';
    });

    await engine.start('harvest', {}, 'run-queuewait');
    await until(() => transport.tasks.length === 1);
    const task = transport.tasks[0]!;

    // 500ms "queued" — 5× past timeoutMs, comfortably inside pickupTimeoutMs: must still be alive.
    await sleep(500);
    expect((await store.getRun('run-queuewait'))?.status).toBe('running');

    // The worker claims it (automatic pickup beat) → the 100ms silence window takes over. Going
    // silent after pickup is now a REAL liveness failure: with retries: 1 the run fails.
    await transport.beat({
      runId: task.runId,
      seq: task.seq,
      stepId: task.stepId,
      group: task.group,
      at: Date.now(),
    });
    const final = await engine.waitForRun('run-queuewait', { terminal: true });
    expect(final.status).toBe('failed');
    expect(final.error?.message).toContain('no result/heartbeat');
  });
});

import { describe, expect, it } from 'vitest';
import type { AdmissionBackend } from '../../src/admission.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { Admission, AdmissionItem, QueueConfig } from '../../src/queue.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/**
 * Backend that blocks admission until `open()` is called, and exposes the `onFreed` callback the
 * engine registers — so the test can fire a "slot freed" signal and assert the engine wakes the
 * blocked run immediately, with NO timer poller running.
 */
class GatedBackend implements AdmissionBackend {
  private blocked = true;
  private freed?: (queue: string) => void;
  register(_config: QueueConfig): void {}
  handles(_queue: string): boolean {
    return true;
  }
  async tryAdmit(_queue: string, _item: AdmissionItem): Promise<Admission> {
    return this.blocked ? { ok: false, retryAt: Number.MAX_SAFE_INTEGER } : { ok: true };
  }
  async release(_queue: string, _slotId: string): Promise<void> {}
  onFreed(handler: (queue: string) => void): void {
    this.freed = handler;
  }
  /** Unblock and signal a freed slot, as a real backend's release→pub/sub would. */
  open(queue: string): void {
    this.blocked = false;
    this.freed?.(queue);
  }
}

async function tick(times = 50) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

describe('engine wakes admission-blocked runs on a freed-slot signal', () => {
  it('resumes a queued run immediately when onFreed fires (no timer poll)', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('payments.charge-card', async (input) => {
      const { amount } = input as { amount: number };
      return { chargeId: `ch_${amount}` };
    });
    const backend = new GatedBackend();

    // wakeAt is MAX_SAFE_INTEGER, so a timer poller could never resume it — only onFreed can.
    const engine = new WorkflowEngine({ store, transport, admission: backend });
    engine.registerQueue({ name: 'charges', concurrency: 1 });
    engine.register('checkout', '1', async (ctx) => {
      const c = await ctx.step<{ chargeId: string }>(
        'payments.charge-card',
        { amount: 7 },
        {
          queue: 'charges',
        },
      );
      return c.chargeId;
    });

    const started = await startRun(engine, 'checkout', {}, 'run1');
    expect(started.status).toBe('suspended'); // blocked on admission

    backend.open('charges'); // a slot frees elsewhere in the fleet
    await tick();

    const run = await store.getRun('run1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toBe('ch_7');
  });
});

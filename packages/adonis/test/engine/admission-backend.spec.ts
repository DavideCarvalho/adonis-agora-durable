import { describe, expect, it } from 'vitest';
import type { AdmissionBackend } from '../../src/admission.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { Admission, AdmissionItem, QueueConfig } from '../../src/queue.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';

/** Records every admission decision so we can assert the engine routes through the injected backend. */
class RecordingBackend implements AdmissionBackend {
  readonly registered: string[] = [];
  readonly admits: Array<{ queue: string; item: AdmissionItem }> = [];
  readonly releases: string[] = [];
  register(config: QueueConfig): void {
    this.registered.push(config.name);
  }
  handles(queue: string): boolean {
    return this.registered.includes(queue);
  }
  async tryAdmit(queue: string, item: AdmissionItem): Promise<Admission> {
    this.admits.push({ queue, item });
    return { ok: true };
  }
  async release(queue: string, _slotId: string): Promise<void> {
    this.releases.push(queue);
  }
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended') return run;
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('WorkflowEngine routes flow-control through an injected AdmissionBackend', () => {
  it('consults the backend on admit and release for a queued remote step', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    transport.handle('payments.charge-card', async (input) => {
      const { amount } = input as { amount: number };
      return { chargeId: `ch_${amount}` };
    });
    const backend = new RecordingBackend();

    const engine = new WorkflowEngine({ store, transport, admission: backend });
    engine.registerQueue({ name: 'charges', concurrency: 1 });
    engine.register('checkout', '1', async (ctx) => {
      const c = await ctx.step<{ chargeId: string }>(
        'payments.charge-card',
        { amount: 42 },
        {
          queue: 'charges',
          priority: 5,
        },
      );
      return c.chargeId;
    });

    await startRun(engine, 'checkout', {}, 'run1');
    await settle(store, 'run1');

    expect(backend.registered).toEqual(['charges']);
    expect(backend.admits).toHaveLength(1);
    expect(backend.admits[0]?.queue).toBe('charges');
    expect(backend.admits[0]?.item.priority).toBe(5);
    expect(backend.releases).toEqual(['charges']);
  });
});

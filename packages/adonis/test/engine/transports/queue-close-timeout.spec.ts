import { describe, expect, it } from 'vitest';
import { sanitizeQueueToken } from '../../../src/tenant-group.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

// `close()` waited a hardcoded 5s for jobs in a handler; `bullmq` and `db` expose the budget as
// `closeTimeoutMs`. The queue transport now does too.
describe('QueueTransport closeTimeoutMs', () => {
  it('bounds the drain by closeTimeoutMs and hands the unfinished job back', async () => {
    const adapter = new MockAdapter();
    const worker = new QueueTransport({
      adapter: () => adapter,
      pollIntervalMs: 5,
      stalledCheckIntervalMs: 0,
      closeTimeoutMs: 50,
    });
    let started = false;
    worker.handle('ext.slow', async () => {
      started = true;
      await new Promise((r) => setTimeout(r, 2_000));
      return 'late';
    });
    await worker.dispatch({
      runId: 'r1',
      seq: 1,
      name: 'ext.slow',
      stepId: 'r1:1',
      group: sanitizeQueueToken('ext.slow'),
      input: {},
      attempt: 1,
    });
    while (!started) await new Promise((r) => setTimeout(r, 2));

    const t0 = Date.now();
    await worker.close();
    expect(Date.now() - t0).toBeLessThan(1_000);
    // Handed back for another worker, not left claimed.
    expect(adapter.active.size).toBe(0);
    expect(adapter.pending.get('durable:tasks:ext.slow')).toHaveLength(1);
  });
});

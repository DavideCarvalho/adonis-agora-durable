import { describe, expect, it } from 'vitest';
import { assertTransportConformance } from '../../../src/testing-kit/index.js';
import { QueueTransport } from '../../../src/transports/queue.js';
import { MockAdapter } from '../../../src/transports/queue-mock-adapter.js';

/**
 * Run the shared Transport contract against the @adonisjs/queue-backed transport (one instance acting
 * as both engine and worker over a mock adapter), proving a remote step round-trips to a worker and
 * back and that a throwing handler surfaces as a failed run — identical to every other transport.
 */
describe('QueueTransport conformance', () => {
  it('satisfies the shared Transport contract', async () => {
    const adapter = new MockAdapter();
    const transport = new QueueTransport({
      adapter: () => adapter,
      group: 'conformance',
      pollIntervalMs: 5,
    });
    await expect(assertTransportConformance(transport)).resolves.toBeUndefined();
  });
});

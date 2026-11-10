import { describe, it } from 'vitest';
import { assertTransportConformance } from '../../../src/testing-kit/index.js';
import { EventEmitterTransport } from '../../../src/transports/event-emitter.js';

/**
 * Run the shared Transport contract against the in-process EventEmitter transport (one instance
 * acting as both engine and worker over a single emitter), proving a remote step round-trips through
 * the event loop to a worker and back and that a throwing handler surfaces as a failed run —
 * identical to every other transport.
 */
describe('EventEmitterTransport conformance', () => {
  it('satisfies the shared Transport contract', async () => {
    await assertTransportConformance(new EventEmitterTransport());
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisAdmissionBackend } from '../src/admission-redis/index.js';
import type { EngineEvent } from '../src/events.js';
import type { RunGateway } from '../src/run-gateway/index.js';
import { RunRequestResponder } from '../src/run-gateway/run-request-responder.js';

/** Background promises the library fires without awaiting must never become unhandled rejections. */
describe('fire-and-forget promises — a rejection is caught, never unhandled', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
  });
  const flush = () => new Promise((r) => setTimeout(r, 30));

  it('RunRequestResponder: re-publishing an event whose run lookup fails', async () => {
    let listener: ((event: EngineEvent) => void) | undefined;
    const gateway = {
      getRun: async () => {
        throw new Error('store down');
      },
    } as unknown as RunGateway;
    const responder = new RunRequestResponder(
      {
        onRunRequest: () => {},
        onStartRun: () => {},
        publishRunReply: async () => {},
        publishTenantEvent: async () => {},
      },
      gateway,
      {
        subscribeEngineEvents: (fn) => {
          listener = fn;
          return () => {};
        },
      },
    );
    responder.start();
    // A step event carries no namespace, so the responder looks the run up.
    listener?.({ type: 'step.completed', runId: 'r1', at: new Date() } as unknown as EngineEvent);
    await flush();
    expect(unhandled).toEqual([]);
  });

  it('RedisAdmissionBackend: the first liveness write failing at construction', async () => {
    const redis = {
      defineCommand: () => {},
      set: async () => {
        throw new Error('ECONNREFUSED');
      },
      duplicate: () => redis,
    };
    const backend = new RedisAdmissionBackend({ connection: redis as never, instanceId: 'i1' });
    await flush();
    await backend.close();
    expect(unhandled).toEqual([]);
  });
});

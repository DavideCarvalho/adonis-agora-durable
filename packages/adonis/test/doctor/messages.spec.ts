import { describe, expect, it } from 'vitest';
import { controlPlanes } from '../../src/control-planes/factory.js';
import { durableDoctorChecks } from '../../src/doctor/checks.js';
import { checkMessages } from '../../src/doctor/messages.js';
import { transports } from '../../src/transports/factory.js';

function fakeApp(config: Record<string, unknown>) {
  return {
    config: { get: (key: string, fallback?: unknown) => config[key] ?? fallback },
    container: { hasBinding: () => false, make: async () => undefined },
  } as never;
}

describe('durable.messages doctor check', () => {
  it('is registered', () => {
    expect(durableDoctorChecks.map((c) => c.id)).toContain('durable.messages');
  });

  it('reports each broker transport and the control plane', async () => {
    const results = await checkMessages(
      fakeApp({
        'app.appKey': 'an-app-key-0123456789abcdef',
        durable: {
          transports: {
            bullmq: transports.bullmq({ connection: 'main', messages: { acceptPlain: false } }),
            jobs: transports.queue(),
            local: transports.db({ messages: { insecure: true } }),
            memory: transports.memory(),
          },
          controlPlane: controlPlanes.redis({ messages: { secret: 'a-shared-secret-of-16+' } }),
        },
      }),
    );
    expect(results).toEqual([
      { status: 'ok', message: 'bullmq messages: app key (auto), plain messages refused.' },
      expect.objectContaining({
        status: 'warn',
        message: expect.stringContaining(
          'jobs messages: app key (auto), accepting plain messages too',
        ),
        fix: expect.stringContaining('acceptPlain: false'),
      }),
      expect.objectContaining({
        status: 'warn',
        message: expect.stringContaining('local messages: plain (insecure): not sealed'),
      }),
      expect.objectContaining({
        status: 'warn',
        message: expect.stringContaining('control plane messages: secret, accepting plain'),
      }),
    ]);
  });

  it('names the fix without a key, and errors on conflicting modes', async () => {
    const previous = process.env.APP_KEY;
    delete process.env.APP_KEY;
    try {
      const [noKey] = await checkMessages(
        fakeApp({ durable: { transports: { bullmq: transports.bullmq({ connection: 'main' }) } } }),
      );
      expect(noKey).toMatchObject({ status: 'warn', fix: expect.stringContaining('set APP_KEY') });
      const [conflict] = await checkMessages(
        fakeApp({
          durable: {
            transports: {
              bullmq: transports.bullmq({
                connection: 'main',
                messages: { insecure: true, secret: 'a-shared-secret-of-16+' },
              }),
            },
          },
        }),
      );
      expect(conflict).toMatchObject({ status: 'error' });
    } finally {
      if (previous !== undefined) process.env.APP_KEY = previous;
    }
  });

  it('skips without a broker transport', async () => {
    const [result] = await checkMessages(fakeApp({ durable: {} }));
    expect(result?.status).toBe('skip');
  });
});

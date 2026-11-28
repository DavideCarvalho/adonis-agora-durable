import { describe, expect, it } from 'vitest';
import { checkTransports } from '../../src/doctor/checks.js';

const factory = async () => ({}) as never;

describe('durable.transports doctor check', () => {
  it('says which transports are built at boot and which on demand', () => {
    const result = checkTransports({
      transport: 'queue',
      transportPool: ['db'],
      transports: { queue: factory, db: factory, bullmq: factory },
    });
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/^Built at boot: "queue", "db"\./);
    expect(result.message).toMatch(/first pins one .*: "bullmq"\./);
  });

  it('a menu of one says only what is built at boot', () => {
    expect(checkTransports({ transport: 'queue', transports: { queue: factory } })).toEqual({
      status: 'ok',
      message: 'Built at boot: "queue".',
    });
    expect(checkTransports(undefined).message).toBe('Built at boot: the in-memory transport.');
  });

  it('flags a transportPool entry transports does not define', () => {
    const result = checkTransports({
      transport: 'queue',
      transportPool: ['nope'],
      transports: { queue: factory },
    });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/"nope"/);
  });

  it('skips a tenant pod', () => {
    expect(checkTransports({ topology: 'tenant' } as never).status).toBe('skip');
  });
});

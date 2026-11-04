import { describe, expect, it } from 'vitest';
import { announcedSubscriptions } from '../../src/handshake/announced.js';
import { descriptorHash, type WorkerDescriptor } from '../../src/handshake/descriptor.js';

const descriptor = (over: Partial<WorkerDescriptor> = {}): WorkerDescriptor => ({
  instanceId: 'w1',
  runtime: 'node',
  sdk: { name: 'test', version: '0' },
  protocol: { version: 1, range: [1, 1] },
  capabilities: [],
  workflows: ['refresh'],
  steps: [],
  registrations: [{ name: 'refresh' }],
  startedAt: 0,
  ...over,
});

describe('announced subscriptions', () => {
  it('folds every live announcement into event -> subscribers', () => {
    const map = announcedSubscriptions([
      descriptor({
        registrations: [{ name: 'refresh', subscribes: ['run.completed:ingest'] }],
      }),
      descriptor({
        instanceId: 'w2',
        workflows: ['alert', 'refresh'],
        registrations: [
          { name: 'alert', subscribes: ['run.failed:ingest', 'run.completed:ingest'] },
          { name: 'refresh', subscribes: ['run.completed:ingest'] },
        ],
      }),
      (({ registrations: _, ...bare }) => bare)(
        descriptor({ instanceId: 'w3', workflows: ['bare'] }),
      ),
    ]);
    expect(Object.fromEntries([...map].map(([event, subs]) => [event, [...subs].sort()]))).toEqual({
      'run.completed:ingest': ['alert', 'refresh'],
      'run.failed:ingest': ['alert'],
    });
  });

  it('hashes subscribes order-insensitively, and leaves the hash of a registration without it alone', () => {
    const plain = descriptor();
    const withSubs = descriptor({
      registrations: [{ name: 'refresh', subscribes: ['b', 'a'] }],
    });
    const reordered = descriptor({
      registrations: [{ name: 'refresh', subscribes: ['a', 'b', 'a'] }],
    });
    expect(descriptorHash(withSubs)).toBe(descriptorHash(reordered));
    expect(descriptorHash(withSubs)).not.toBe(descriptorHash(plain));
    expect(descriptorHash(plain)).toBe(
      descriptorHash(descriptor({ registrations: [{ name: 'refresh' }] })),
    );
  });
});

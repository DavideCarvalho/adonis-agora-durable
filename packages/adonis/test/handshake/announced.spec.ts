import { describe, expect, it } from 'vitest';
import { aggregateAnnouncements, announcementsOf } from '../../src/handshake/announced.js';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';

/** A live worker's descriptor. Only the fields the registry reads are interesting here. */
function worker(over: Partial<WorkerDescriptor> & { instanceId: string }): WorkerDescriptor {
  return {
    runtime: 'node',
    sdk: { name: 'sdk', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [],
    steps: [],
    startedAt: 0,
    ...over,
  };
}

describe('announcementsOf — what one descriptor claims', () => {
  it('reads the rich registrations when present', () => {
    const d = worker({
      instanceId: 'py-1',
      runtime: 'python',
      registrations: [{ name: 'pipeline', version: '2', group: 'pipeline@acme', origin: 'flip' }],
    });
    expect(announcementsOf(d)).toEqual([
      {
        name: 'pipeline',
        version: '2',
        group: 'pipeline@acme',
        origin: 'flip',
        instanceId: 'py-1',
        runtime: 'python',
      },
    ]);
  });

  it('accepts a bare `workflows` name as a valid announcement — every SDK already publishes it', () => {
    const d = worker({ instanceId: 'py-1', runtime: 'python', workflows: ['pipeline'] });
    // Unversioned and group-less: what a pre-registrations worker actually knows about itself. The
    // aggregate reports it as such rather than declining to list a workflow that really is served.
    expect(announcementsOf(d)).toEqual([
      { name: 'pipeline', instanceId: 'py-1', runtime: 'python' },
    ]);
  });

  it('covers a name announced BOTH ways once, and a name announced only flatly as well', () => {
    const d = worker({
      instanceId: 'w1',
      workflows: ['pipeline', 'legacy'],
      registrations: [{ name: 'pipeline', version: '2' }],
    });
    expect(announcementsOf(d).map((a) => `${a.name}@${a.version ?? ''}`)).toEqual([
      'pipeline@2',
      'legacy@',
    ]);
  });

  it('announces nothing for a descriptor with no workflows (a step-only worker, or the CP itself)', () => {
    expect(announcementsOf(worker({ instanceId: 'steps-1', steps: ['charge'] }))).toEqual([]);
  });
});

describe('aggregateAnnouncements — one entry per name@version', () => {
  it('folds replicas of the same worker into ONE entry counting both instances', () => {
    const reg = [{ name: 'pipeline', version: '2', group: 'pipeline' }];
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: reg }),
      worker({ instanceId: 'w2', registrations: reg }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.key).toBe('pipeline@2');
    expect(out[0]?.instances).toEqual(['w1', 'w2']);
    expect(out[0]?.disagreements).toEqual([]);
  });

  it('counts an instance once even when it announces under several tokens', () => {
    // A worker publishes the SAME descriptor under every token it consumes, so the reader can see
    // it repeatedly. `instances` is how many WORKERS can run it, not how many keys were read.
    const d = worker({ instanceId: 'w1', registrations: [{ name: 'pipeline' }] });
    expect(aggregateAnnouncements([d, d, d])[0]?.instances).toEqual(['w1']);
  });

  it('keeps two versions of one name apart', () => {
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: [{ name: 'pipeline', version: '1' }] }),
      worker({ instanceId: 'w2', registrations: [{ name: 'pipeline', version: '2' }] }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['pipeline@1', 'pipeline@2']);
  });

  it('never folds an unversioned announcement into a versioned one', () => {
    // Assuming the name-only worker serves version 2 would be exactly the inference this registry
    // exists to avoid — a picker would offer a version nobody claimed.
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: [{ name: 'pipeline', version: '2' }] }),
      worker({ instanceId: 'py-1', runtime: 'python', workflows: ['pipeline'] }),
    ]);
    expect(out.map((e) => e.key)).toEqual(['pipeline', 'pipeline@2']);
    expect(out[0]?.version).toBeUndefined();
  });

  it('reports a python-served and a node-served workflow with their runtimes', () => {
    const out = aggregateAnnouncements([
      worker({ instanceId: 'py-1', runtime: 'python', registrations: [{ name: 'pipeline' }] }),
      worker({ instanceId: 'ts-1', runtime: 'node', registrations: [{ name: 'pipeline' }] }),
    ]);
    expect(out[0]?.runtimes).toEqual(['node', 'python']);
  });

  it('is empty when the fleet announces nothing — a picker gets no options, not a wrong one', () => {
    expect(aggregateAnnouncements([])).toEqual([]);
    expect(aggregateAnnouncements([worker({ instanceId: 'steps-1', steps: ['charge'] })])).toEqual(
      [],
    );
  });
});

describe('aggregateAnnouncements — disagreement is reported, never resolved', () => {
  it('lists BOTH groups and flags the axis when two workers serve one version from different queues', () => {
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: [{ name: 'pipeline', version: '2', group: 'a' }] }),
      worker({ instanceId: 'w2', registrations: [{ name: 'pipeline', version: '2', group: 'b' }] }),
    ]);
    expect(out[0]?.groups).toEqual(['a', 'b']);
    expect(out[0]?.disagreements).toEqual([{ axis: 'group', values: ['a', 'b'] }]);
  });

  it('flags two packages claiming one name@version — the name collision a picker must not paper over', () => {
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: [{ name: 'pipeline', origin: 'flip' }] }),
      worker({ instanceId: 'w2', registrations: [{ name: 'pipeline', origin: 'acme-lib' }] }),
    ]);
    expect(out[0]?.origins).toEqual(['acme-lib', 'flip']);
    expect(out[0]?.disagreements).toEqual([{ axis: 'origin', values: ['acme-lib', 'flip'] }]);
  });

  it('flags two different capability demands for the same version', () => {
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: [{ name: 'p', requires: ['saga'] }] }),
      worker({ instanceId: 'w2', registrations: [{ name: 'p', requires: ['saga', 'signals'] }] }),
    ]);
    expect(out[0]?.requires).toEqual([['saga'], ['saga', 'signals']]);
    expect(out[0]?.disagreements).toEqual([{ axis: 'requires', values: ['saga', 'saga,signals'] }]);
  });

  it('treats a capability demand as a SET — the same demand written two ways agrees', () => {
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: [{ name: 'p', requires: ['saga', 'signals'] }] }),
      worker({ instanceId: 'w2', registrations: [{ name: 'p', requires: ['signals', 'saga'] }] }),
    ]);
    expect(out[0]?.requires).toEqual([['saga', 'signals']]);
    expect(out[0]?.disagreements).toEqual([]);
  });

  it('silence is not a claim: an announcer that stated nothing does not disagree with one that did', () => {
    const out = aggregateAnnouncements([
      worker({ instanceId: 'w1', registrations: [{ name: 'p', group: 'p', origin: 'flip' }] }),
      worker({ instanceId: 'py-1', runtime: 'python', workflows: ['p'] }),
    ]);
    const entry = out.find((e) => e.key === 'p');
    expect(entry?.groups).toEqual(['p']);
    expect(entry?.origins).toEqual(['flip']);
    expect(entry?.disagreements).toEqual([]);
    expect(entry?.instances).toEqual(['py-1', 'w1']);
  });

  it('reports every axis at once, and picks a winner on none of them', () => {
    const out = aggregateAnnouncements([
      worker({
        instanceId: 'w1',
        registrations: [{ name: 'p', version: '1', group: 'a', origin: 'x', requires: ['saga'] }],
      }),
      worker({
        instanceId: 'w2',
        registrations: [{ name: 'p', version: '1', group: 'b', origin: 'y', requires: [] }],
      }),
    ]);
    expect(out[0]?.disagreements.map((d) => d.axis)).toEqual(['group', 'origin', 'requires']);
    expect(out[0]?.groups).toEqual(['a', 'b']);
  });
});

describe('aggregateAnnouncements — onError routes', () => {
  const routed = (instanceId: string, onError?: { code?: string; workflow: string }[]) =>
    worker({
      instanceId,
      registrations: [{ name: 'line', version: '1', ...(onError ? { onError } : {}) }],
    });

  it('folds the same routes, listed in any order, into one set', () => {
    const [entry] = aggregateAnnouncements([
      routed('a', [{ code: 'x', workflow: 'dlq' }, { workflow: 'all' }]),
      routed('b', [{ workflow: 'all' }, { code: 'x', workflow: 'dlq' }]),
    ]);
    expect(entry?.onError).toEqual([[{ code: 'x', workflow: 'dlq' }, { workflow: 'all' }]]);
    expect(entry?.disagreements).toEqual([]);
  });

  it('flags workers that route the same workflow differently', () => {
    const [entry] = aggregateAnnouncements([
      routed('a', [{ code: 'x', workflow: 'dlq' }]),
      routed('b', [{ code: 'x', workflow: 'dlq-v2' }]),
    ]);
    expect(entry?.onError).toHaveLength(2);
    expect(entry?.disagreements.map((d) => d.axis)).toEqual(['onError']);
  });

  it('does not count a worker that states no routes as disagreeing', () => {
    const [entry] = aggregateAnnouncements([routed('a', [{ workflow: 'dlq' }]), routed('b')]);
    expect(entry?.onError).toEqual([[{ workflow: 'dlq' }]]);
    expect(entry?.disagreements).toEqual([]);
  });
});

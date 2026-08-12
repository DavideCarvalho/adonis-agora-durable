import { describe, expect, it } from 'vitest';
import type { GroupHealth, WorkerHeartbeat, WorkerStatus } from './durable-client.js';
import { pivotByWorker } from './pivot-by-worker.js';

function status(over: Partial<WorkerStatus> = {}): WorkerStatus {
  return { concurrency: { mode: 'fixed', limit: 1 }, inFlight: 0, ...over };
}

function heartbeat(over: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return { group: 'SomeHandler', instanceId: 'w1', lastBeatAt: 0, ...over };
}

function groupHealth(over: Partial<GroupHealth> = {}): GroupHealth {
  return { group: 'SomeHandler', depth: 0, liveWorkers: [], ...over };
}

describe('pivotByWorker', () => {
  it('two workers each serving the same 3 groups collapse to one row per worker', () => {
    const groups: GroupHealth[] = [
      groupHealth({
        group: 'HandlerA',
        liveWorkers: [
          heartbeat({ group: 'HandlerA', instanceId: 'w1', lastBeatAt: 1 }),
          heartbeat({ group: 'HandlerA', instanceId: 'w2', lastBeatAt: 1 }),
        ],
      }),
      groupHealth({
        group: 'HandlerB',
        liveWorkers: [
          heartbeat({ group: 'HandlerB', instanceId: 'w1', lastBeatAt: 1 }),
          heartbeat({ group: 'HandlerB', instanceId: 'w2', lastBeatAt: 1 }),
        ],
      }),
      groupHealth({
        group: 'HandlerC',
        liveWorkers: [
          heartbeat({ group: 'HandlerC', instanceId: 'w1', lastBeatAt: 1 }),
          heartbeat({ group: 'HandlerC', instanceId: 'w2', lastBeatAt: 1 }),
        ],
      }),
    ];

    const result = pivotByWorker(groups);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      instanceId: 'w1',
      handlers: ['HandlerA', 'HandlerB', 'HandlerC'],
    });
    expect(result[1]).toMatchObject({
      instanceId: 'w2',
      handlers: ['HandlerA', 'HandlerB', 'HandlerC'],
    });
  });

  it('the same instanceId across groups dedupes to a single row', () => {
    const groups: GroupHealth[] = [
      groupHealth({
        group: 'HandlerA',
        liveWorkers: [heartbeat({ group: 'HandlerA', instanceId: 'w1', lastBeatAt: 1 })],
      }),
      groupHealth({
        group: 'HandlerB',
        liveWorkers: [heartbeat({ group: 'HandlerB', instanceId: 'w1', lastBeatAt: 2 })],
      }),
    ];

    const result = pivotByWorker(groups);

    expect(result).toHaveLength(1);
    expect(result[0]?.instanceId).toBe('w1');
    expect(result[0]?.handlers).toEqual(['HandlerA', 'HandlerB']);
  });

  it('status/runtime/lastBeatAt are taken from the latest heartbeat', () => {
    const oldStatus = status({ runtime: 'node', inFlight: 3 });
    const newStatus = status({ runtime: 'python', inFlight: 7 });
    const groups: GroupHealth[] = [
      groupHealth({
        group: 'HandlerA',
        liveWorkers: [
          heartbeat({ group: 'HandlerA', instanceId: 'w1', lastBeatAt: 10, status: oldStatus }),
        ],
      }),
      groupHealth({
        group: 'HandlerB',
        liveWorkers: [
          heartbeat({ group: 'HandlerB', instanceId: 'w1', lastBeatAt: 20, status: newStatus }),
        ],
      }),
    ];

    const result = pivotByWorker(groups);

    expect(result[0]?.lastBeatAt).toBe(20);
    expect(result[0]?.runtime).toBe('python');
    expect(result[0]?.status).toBe(newStatus);
  });

  it('partition is derived from the @tenant suffix vs. the default (no-suffix) group', () => {
    const groups: GroupHealth[] = [
      groupHealth({
        group: 'HandlerA@acme',
        liveWorkers: [heartbeat({ group: 'HandlerA@acme', instanceId: 'w-acme', lastBeatAt: 1 })],
      }),
      groupHealth({
        group: 'HandlerA',
        liveWorkers: [heartbeat({ group: 'HandlerA', instanceId: 'w-default', lastBeatAt: 1 })],
      }),
    ];

    const result = pivotByWorker(groups);

    const acme = result.find((worker) => worker.instanceId === 'w-acme');
    const defaultWorker = result.find((worker) => worker.instanceId === 'w-default');
    expect(acme?.partition).toBe('acme');
    expect(acme?.handlers).toEqual(['HandlerA']);
    expect(defaultWorker?.partition).toBe('default');
  });

  it('sorts default partition first, then alphabetically, then by instanceId', () => {
    const groups: GroupHealth[] = [
      groupHealth({
        group: 'HandlerA@zeta',
        liveWorkers: [heartbeat({ group: 'HandlerA@zeta', instanceId: 'z1', lastBeatAt: 1 })],
      }),
      groupHealth({
        group: 'HandlerA@acme',
        liveWorkers: [heartbeat({ group: 'HandlerA@acme', instanceId: 'a1', lastBeatAt: 1 })],
      }),
      groupHealth({
        group: 'HandlerA',
        liveWorkers: [
          heartbeat({ group: 'HandlerA', instanceId: 'w2', lastBeatAt: 1 }),
          heartbeat({ group: 'HandlerA', instanceId: 'w1', lastBeatAt: 1 }),
        ],
      }),
    ];

    const result = pivotByWorker(groups);

    expect(result.map((worker) => worker.instanceId)).toEqual(['w1', 'w2', 'a1', 'z1']);
  });

  it('empty input returns an empty array', () => {
    expect(pivotByWorker([])).toEqual([]);
  });
});

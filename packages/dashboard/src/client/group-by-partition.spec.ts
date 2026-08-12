import { describe, expect, it } from 'vitest';
import type { GroupHealth, WorkerHeartbeat } from './durable-client.js';
import { groupByPartition } from './group-by-partition.js';

function worker(over: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return { group: '', instanceId: 'w1', lastBeatAt: 0, ...over };
}

function group(over: Partial<GroupHealth> = {}): GroupHealth {
  return { group: 'Handler', depth: 0, liveWorkers: [], ...over };
}

describe('groupByPartition', () => {
  it('splits groups across default and a named partition', () => {
    const views = groupByPartition([
      group({ group: 'IngestWorkflow', depth: 1 }),
      group({ group: 'ProcessKpi@davi-local', depth: 2 }),
    ]);
    expect(views.map((v) => v.partition)).toEqual(['default', 'davi-local']);
    expect(views[0]).toMatchObject({ partition: 'default', handlerCount: 1, totalDepth: 1 });
    expect(views[1]).toMatchObject({ partition: 'davi-local', handlerCount: 1, totalDepth: 2 });
  });

  it('a worker instanceId serving 3 queues in one partition counts once', () => {
    const views = groupByPartition([
      group({
        group: 'A@davi-local',
        liveWorkers: [worker({ group: 'A@davi-local', instanceId: 'w1' })],
      }),
      group({
        group: 'B@davi-local',
        liveWorkers: [worker({ group: 'B@davi-local', instanceId: 'w1' })],
      }),
      group({
        group: 'C@davi-local',
        liveWorkers: [worker({ group: 'C@davi-local', instanceId: 'w1' })],
      }),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ partition: 'davi-local', workerCount: 1, handlerCount: 3 });
  });

  it('starvedCount counts groups with depth > 0 and no live workers', () => {
    const views = groupByPartition([
      group({ group: 'A', depth: 5, liveWorkers: [] }),
      group({ group: 'B', depth: 0, liveWorkers: [] }),
      group({ group: 'C', depth: 3, liveWorkers: [worker()] }),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]?.starvedCount).toBe(1);
  });

  it('totalDepth sums group depths within a partition', () => {
    const views = groupByPartition([
      group({ group: 'A', depth: 4 }),
      group({ group: 'B', depth: 6 }),
    ]);
    expect(views[0]?.totalDepth).toBe(10);
  });

  it('sorts default first, then alphabetically', () => {
    const views = groupByPartition([
      group({ group: 'A@zeta' }),
      group({ group: 'B@alpha' }),
      group({ group: 'C' }),
      group({ group: 'D@mid' }),
    ]);
    expect(views.map((v) => v.partition)).toEqual(['default', 'alpha', 'mid', 'zeta']);
  });

  it('empty input returns an empty array', () => {
    expect(groupByPartition([])).toEqual([]);
  });
});

import type { GroupHealth } from './durable-client.js';
import { partitionOf } from './queue-partition.js';

/** Rolled-up worker health for one tenant-isolation partition (see `partitionOf`). */
export interface PartitionView {
  partition: string;
  /** Distinct `instanceId`s across every group's `liveWorkers` in this partition. */
  workerCount: number;
  /** Number of groups (queues) bucketed into this partition. */
  handlerCount: number;
  /** Sum of `depth` across the partition's groups. */
  totalDepth: number;
  /** Groups with a nonzero backlog and no live worker. */
  starvedCount: number;
}

/**
 * Bucket `GroupHealth[]` by `partitionOf(group.group)` and roll up counts. A worker that serves
 * multiple queues in the same partition is counted once toward `workerCount` — we dedupe by
 * `instanceId` across the whole partition, not per group. `'default'` (the operator/control-plane
 * partition) sorts first; the rest follow alphabetically.
 */
export function groupByPartition(groups: GroupHealth[]): PartitionView[] {
  const byPartition = new Map<string, GroupHealth[]>();

  for (const group of groups) {
    const partition = partitionOf(group.group);
    const existing = byPartition.get(partition);
    if (existing) {
      existing.push(group);
    } else {
      byPartition.set(partition, [group]);
    }
  }

  const views = [...byPartition.entries()].map(([partition, partitionGroups]) => {
    const workerIds = new Set<string>();
    let totalDepth = 0;
    let starvedCount = 0;

    for (const group of partitionGroups) {
      totalDepth += group.depth;
      if (group.depth > 0 && group.liveWorkers.length === 0) starvedCount += 1;
      for (const worker of group.liveWorkers) workerIds.add(worker.instanceId);
    }

    return {
      partition,
      workerCount: workerIds.size,
      handlerCount: partitionGroups.length,
      totalDepth,
      starvedCount,
    };
  });

  return views.sort((a, b) => {
    if (a.partition === 'default') return -1;
    if (b.partition === 'default') return 1;
    return a.partition.localeCompare(b.partition);
  });
}

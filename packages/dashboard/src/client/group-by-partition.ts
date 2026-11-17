import type { GroupHealth } from './durable-client.js';
import { partitionOf } from './queue-partition.js';

/** Rolled-up worker health for one tenant-isolation partition (see `partitionOf`). */
export interface PartitionView {
  partition: string;
  /** Distinct `instanceId`s across every group's `liveWorkers` in this partition. */
  workerCount: number;
  /** Number of groups (queues) bucketed into this partition. */
  handlerCount: number;
  /**
   * Jobs queued in the partition: the sum of the groups' `depth`, except that groups sharing one
   * queue (BullMQ `taskQueues: 'grouped'`) count that queue's `queueDepth` once, which stays exact
   * when the per-group split was sampled.
   */
  totalDepth: number;
  /** The shared queues the partition's groups wait on (empty when every group has its own queue). */
  sharedQueues: string[];
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
    const sharedDepth = new Map<string, number>();
    let totalDepth = 0;
    let starvedCount = 0;

    for (const group of partitionGroups) {
      if (group.queue !== undefined) {
        sharedDepth.set(
          group.queue,
          Math.max(sharedDepth.get(group.queue) ?? 0, group.queueDepth ?? group.depth),
        );
        // The backlog still draining from the group's old queue is not in `queueDepth`.
        totalDepth += group.drainingDepth ?? 0;
      } else {
        totalDepth += group.depth;
      }
      if (group.depth > 0 && group.liveWorkers.length === 0) starvedCount += 1;
      for (const worker of group.liveWorkers) workerIds.add(worker.instanceId);
    }

    for (const depth of sharedDepth.values()) totalDepth += depth;

    return {
      partition,
      workerCount: workerIds.size,
      handlerCount: partitionGroups.length,
      totalDepth,
      sharedQueues: [...sharedDepth.keys()].sort(),
      starvedCount,
    };
  });

  return views.sort((a, b) => {
    if (a.partition === 'default') return -1;
    if (b.partition === 'default') return 1;
    return a.partition.localeCompare(b.partition);
  });
}

import type { GroupHealth, WorkerStatus } from './durable-client.js';
import { baseHandlerName, partitionOf } from './queue-partition.js';

/** One real worker pod, pivoted out of the `group → liveWorkers` shape the engine reports. A single
 *  process subscribes to many handler queues and heartbeats into each, so `GroupHealth.liveWorkers`
 *  repeats the same `instanceId` under every group it serves — this collapses those back to one row. */
export interface WorkerView {
  instanceId: string;
  /** The partition this worker serves; its groups share one (see `partitionOf`). */
  partition: string;
  runtime?: 'node' | 'python' | undefined;
  /** `baseHandlerName()` of every group this worker appears in, deduped and sorted ascending. */
  handlers: string[];
  /** From the heartbeat with the greatest `lastBeatAt`. */
  status?: WorkerStatus | undefined;
  /** Max `lastBeatAt` across this worker's heartbeats. */
  lastBeatAt: number;
}

/** Accumulator kept per `instanceId` while walking every group's heartbeats. */
interface WorkerAccumulator {
  instanceId: string;
  partition: string;
  runtime?: 'node' | 'python' | undefined;
  handlers: Set<string>;
  status?: WorkerStatus | undefined;
  lastBeatAt: number;
}

/**
 * Pivot per-group worker health into per-worker health: `group → workers` becomes
 * `worker → the groups it serves`. Each worker's `status`/`runtime` come from its most recent
 * heartbeat (greatest `lastBeatAt`); `partition` follows that same latest heartbeat's group, which
 * also covers the (should-never-happen) case of a worker whose groups disagree on partition.
 */
export function pivotByWorker(groups: GroupHealth[]): WorkerView[] {
  const byInstance = new Map<string, WorkerAccumulator>();

  for (const group of groups) {
    for (const heartbeat of group.liveWorkers) {
      const handler = baseHandlerName(heartbeat.group);
      const existing = byInstance.get(heartbeat.instanceId);
      if (existing === undefined) {
        byInstance.set(heartbeat.instanceId, {
          instanceId: heartbeat.instanceId,
          partition: partitionOf(heartbeat.group),
          runtime: heartbeat.status?.runtime,
          handlers: new Set([handler]),
          status: heartbeat.status,
          lastBeatAt: heartbeat.lastBeatAt,
        });
        continue;
      }
      existing.handlers.add(handler);
      if (heartbeat.lastBeatAt >= existing.lastBeatAt) {
        existing.lastBeatAt = heartbeat.lastBeatAt;
        existing.partition = partitionOf(heartbeat.group);
        existing.runtime = heartbeat.status?.runtime;
        existing.status = heartbeat.status;
      }
    }
  }

  return [...byInstance.values()]
    .map((worker) => ({
      instanceId: worker.instanceId,
      partition: worker.partition,
      runtime: worker.runtime,
      handlers: [...worker.handlers].sort((a, b) => a.localeCompare(b)),
      status: worker.status,
      lastBeatAt: worker.lastBeatAt,
    }))
    .sort((a, b) => {
      if (a.partition !== b.partition) {
        // 'default' always sorts first; everything else falls back to alphabetical.
        if (a.partition === 'default') return -1;
        if (b.partition === 'default') return 1;
        return a.partition.localeCompare(b.partition);
      }
      return a.instanceId.localeCompare(b.instanceId);
    });
}

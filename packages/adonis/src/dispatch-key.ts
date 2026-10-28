import type { RemoteTask } from './interfaces.js';

/**
 * The identity of ONE dispatch of a step: the same step (`stepId`), the same attempt, and the same
 * checkpoint incarnation (the `enqueuedAt` its `pending` checkpoint was written with). A broker that
 * can deduplicate by key (BullMQ, through a deterministic job id) turns a re-send of the same dispatch
 * into a no-op while the original job still waits or runs — the case of a crashed turn's steps being
 * re-dispatched on recovery although their dispatch did land.
 *
 * Carried on the task under a SYMBOL key: object spreads keep it, every serializer (JSON, structured
 * clone) drops it, so the task's wire format is unchanged and a transport that does not know it
 * ignores it. Internal — not exported from the package.
 *
 * The incarnation is part of the key because neither `stepId` nor the attempt is unique over a run's
 * life: a retried (`requeue`) step restarts its attempts on the same `stepId`, and a broker may keep
 * a failed job of the earlier incarnation (BullMQ keeps failed task jobs for a day) — a key without
 * it would turn the new dispatch into a no-op against that leftover.
 */
export const DISPATCH_KEY: unique symbol = Symbol.for('@adonis-agora/durable.dispatchKey');

/** A task that may carry its {@link DISPATCH_KEY}. */
export type KeyedTask = RemoteTask & { [DISPATCH_KEY]?: string };

/** The {@link DISPATCH_KEY} of the dispatch of `stepId` at `attempt` whose checkpoint was enqueued at `enqueuedAt`. */
export function dispatchKey(stepId: string, attempt: number, enqueuedAt: Date): string {
  return `${stepId}|${attempt}|${enqueuedAt.getTime()}`;
}

/** The {@link DISPATCH_KEY} `task` carries, if any. */
export function dispatchKeyOf(task: RemoteTask): string | undefined {
  const key = (task as KeyedTask)[DISPATCH_KEY];
  return typeof key === 'string' ? key : undefined;
}

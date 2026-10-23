import type { StateStore, WorkflowRun } from './interfaces.js';

/**
 * Stamped on a finished child whose completion its parent settled from the child's run row (the
 * child's own notification had not arrived). A notification that arrives after that finds no waiter
 * and, seeing the stamp, is dropped instead of buffered: a buffered copy would never be consumed.
 */
export const CHILD_DELIVERED_TAG = 'durable:child:delivered';

/**
 * Stamp `child` with {@link CHILD_DELIVERED_TAG} before its parent settles the wait from its row. Must
 * be written before the parent removes its waiter: a late notification that finds the waiter gone
 * then finds the stamp. `updatedAt` is left alone, so retention ages the child as before.
 */
export async function markChildDelivered(store: StateStore, child: WorkflowRun): Promise<void> {
  if (child.tags?.includes(CHILD_DELIVERED_TAG)) return;
  await store.updateRun(child.id, { tags: [...(child.tags ?? []), CHILD_DELIVERED_TAG] });
}

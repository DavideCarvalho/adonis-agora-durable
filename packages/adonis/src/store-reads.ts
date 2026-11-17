import { childIdsOf, FOLDED_PREFIX } from './fan-join.js';
import type { RunQuery, StateStore } from './interfaces.js';
import { LIFECYCLE_REGISTRY_WORKFLOW } from './lifecycle-events.js';
import { listSignalWaitersOfRuns } from './run-waiting.js';

/**
 * Reads over a {@link StateStore} alone, shared by the engine's read API and the consoles that read
 * another app's store directly (the federated console): the same answer either way.
 */

/** Checkpoint names that record a parent→child edge: an awaited child, a folded group of them, a spawn. */
const CHILD_EDGE_PREFIXES = ['signal:child:', FOLDED_PREFIX, 'spawn:'];

/**
 * `query` without the engine's bookkeeping runs (the lifecycle subscription registry), unless it asks
 * for them by name.
 */
export function withoutBookkeepingRuns<
  Q extends Pick<RunQuery, 'workflow' | 'workflows' | 'excludeWorkflows'>,
>(query: Q): Q {
  if (
    query.workflow === LIFECYCLE_REGISTRY_WORKFLOW ||
    query.workflows?.includes(LIFECYCLE_REGISTRY_WORKFLOW)
  ) {
    return query;
  }
  const excluded = query.excludeWorkflows ?? [];
  if (excluded.includes(LIFECYCLE_REGISTRY_WORKFLOW)) return query;
  return { ...query, excludeWorkflows: [...excluded, LIFECYCLE_REGISTRY_WORKFLOW] };
}

/**
 * The child run ids of `parentRunId`: its `child:` signal waiters (still awaited) plus its child-edge
 * checkpoints (already settled ones, and a folded `ctx.all` group standing for every child in it).
 */
export async function runChildrenFromStore(
  store: StateStore,
  parentRunId: string,
): Promise<string[]> {
  const childIds = new Set<string>();
  // The parent's own waiters only (an indexed `WHERE run_id` when the store has it).
  for (const w of await listSignalWaitersOfRuns(store, [parentRunId])) {
    if (w.token.startsWith('child:')) childIds.add(w.token.slice('child:'.length));
  }
  // Targeted read: only the child-edge checkpoints, not the whole history. Falls back to a full
  // listCheckpoints + in-JS prefix scan for a custom store that omits the method.
  const childCheckpoints = store.listCheckpointsByNamePrefix
    ? await store.listCheckpointsByNamePrefix(parentRunId, CHILD_EDGE_PREFIXES)
    : (await store.listCheckpoints(parentRunId)).filter((cp) =>
        CHILD_EDGE_PREFIXES.some((p) => cp.name.startsWith(p)),
      );
  for (const id of childIdsOf(childCheckpoints)) childIds.add(id);
  return [...childIds];
}

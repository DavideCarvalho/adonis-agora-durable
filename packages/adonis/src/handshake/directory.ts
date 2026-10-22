/**
 * The workflow directory — {@link ./announced}'s registry plus the thing an empty registry could
 * never say: WHY it is empty.
 *
 * ## The three states an empty list used to collapse
 *
 * "What workflows can I call?" has three honest answers, and returning `[]` for all of them is the
 * bug this module exists to fix. They are not shades of the same answer; they call for three
 * different actions from whoever asked.
 *
 * 1. **This process cannot ask.** No transport here can introspect the advertisement or liveness
 *    keyspace — a pure in-process pool advertises nothing and scans nothing. Workers may well be
 *    running; nobody looked. ({@link WorkflowDirectory.supported} is `false`.) The action is to
 *    configure a transport, or to stop treating this pod's answer as the deployment's answer.
 * 2. **Nothing is live.** The fleet WAS asked and the fleet is empty. ({@link WorkflowDirectory.supported}
 *    is `true`, `workflows` is `[]`.) The action is to start a worker.
 * 3. **Here it is.** ({@link WorkflowDirectory.supported} is `true`, `workflows` is populated.)
 *
 * There is a fourth that hides inside the second and is the most expensive to debug, because it
 * looks exactly like "nobody is running" from the caller's side: **a worker is live on a partition
 * this engine does not serve.** A worker started with a partition consumes `<token>@<partition>`,
 * convention resolution computes the token for THIS engine's namespace, misses, and reports absence.
 * The heartbeat keyspace is shared, so the evidence is right there — and
 * {@link WorkflowDirectory.otherPartitions} reports it instead of letting the caller conclude that
 * nothing exists.
 *
 * ## Why a sentence rides along
 *
 * Every field here is structured and a caller can branch on all of it. {@link WorkflowDirectory.detail}
 * exists anyway because the three states are only useful if the human reading the picker learns which
 * one they are in, and a UI that has to re-derive that prose from booleans will re-derive it
 * differently in each place it is shown. The sentence is written once, next to the logic that decides
 * which state it is.
 */

import type { AnnouncedWorkflow, HeartbeatSighting } from './announced.js';
import { aggregateAnnouncements, coveredTokens, observedAnnouncements } from './announced.js';
import type { RawWorkerDescriptor, WorkerDescriptor } from './descriptor.js';

/** The namespace a descriptor or a bare routing token belongs to when it states none. Mirrors
 *  `tenantGroup`'s default-is-bare rule, so a single-tenant deployment reads as `'default'`
 *  everywhere rather than as a special case. */
export const DEFAULT_PARTITION = 'default';

/** Live workers seen on a partition the asking engine does not serve — the case that otherwise reads
 *  identically to "nothing is running". */
export interface PartitionSighting {
  /** The partition suffix carried by the tokens (never this engine's own). */
  partition: string;
  /** The routing tokens live on it, as published (sorted). */
  groups: string[];
  /** The instance ids beating there (sorted). */
  instances: string[];
}

/** What the live fleet can be asked, and what it answered. See the module docblock for the states. */
export interface WorkflowDirectory {
  /**
   * Could this process ask the fleet at all?
   *
   * `false` means no transport here can read the advertisement or liveness keyspace, so `workflows`
   * is empty because nothing was asked — NOT because nothing is running. `true` means the read
   * happened and `workflows` is the answer, including when it is empty.
   */
  supported: boolean;
  /** Everything callable in this engine's partition, declared and observed alike. */
  workflows: AnnouncedWorkflow[];
  /** Live workers on OTHER partitions (empty for an operator engine, which serves them all). */
  otherPartitions: PartitionSighting[];
  /** One sentence saying which state this is and what it implies. Written for a human. */
  detail: string;
}

/** The partition a routing token belongs to: the suffix after the LAST `@`, or {@link DEFAULT_PARTITION}
 *  for a bare token. Matches how `tenantGroup` builds the token and how `workerHealth` takes it apart. */
export function partitionOfToken(token: string): string {
  const at = token.lastIndexOf('@');
  return at === -1 ? DEFAULT_PARTITION : token.slice(at + 1);
}

/**
 * Fold live descriptors and live heartbeats into the directory for one engine.
 *
 * `namespace` is the asking engine's, and `undefined` means an operator that serves every partition:
 * it filters nothing and reports no foreign partitions, because
 * none of them are foreign to it. A namespaced engine sees only its own partition's workers, and
 * everything else it can see is reported as a sighting rather than silently dropped — dropping is
 * what made a misconfigured partition indistinguishable from an empty fleet.
 *
 * Pure and holds nothing: the caller does the two live reads it already knows how to do, folds them
 * here, and drops the result.
 */
export function buildWorkflowDirectory(input: {
  descriptors: readonly (RawWorkerDescriptor | WorkerDescriptor)[];
  heartbeats: readonly HeartbeatSighting[];
  namespace: string | undefined;
  /** Whether ANY transport in the pool could perform the reads above. */
  supported: boolean;
  /** The queue-token form of a workflow name — injected so this module needs no queue dependency. */
  sanitize: (name: string) => string;
}): WorkflowDirectory {
  const { descriptors, heartbeats, namespace, supported, sanitize } = input;
  if (!supported) {
    return {
      supported: false,
      workflows: [],
      otherPartitions: [],
      detail:
        'No transport in this process can read what the fleet advertises, so nothing here was asked and this list is empty for that reason alone. Workers may well be running. A workflow can still be called by name.',
    };
  }

  const mine = namespace === undefined ? undefined : namespace;
  const ownDescriptors =
    mine === undefined
      ? descriptors
      : descriptors.filter((d) => (d.namespace ?? DEFAULT_PARTITION) === mine);
  const ownBeats: HeartbeatSighting[] = [];
  const foreign = new Map<string, { groups: Set<string>; instances: Set<string> }>();
  for (const beat of heartbeats) {
    if (!beat.group) continue;
    const partition = partitionOfToken(beat.group);
    if (mine === undefined || partition === mine) {
      ownBeats.push(beat);
      continue;
    }
    const seen = foreign.get(partition);
    if (seen) {
      seen.groups.add(beat.group);
      seen.instances.add(beat.instanceId);
    } else {
      foreign.set(partition, {
        groups: new Set([beat.group]),
        instances: new Set([beat.instanceId]),
      });
    }
  }

  const declared = aggregateAnnouncements(ownDescriptors);
  const observed = observedAnnouncements(
    ownBeats,
    coveredTokens(declared, ownDescriptors, sanitize),
  );
  const workflows = [...declared, ...observed].sort((a, b) => a.key.localeCompare(b.key));
  const otherPartitions: PartitionSighting[] = [...foreign.entries()]
    .map(([partition, seen]) => ({
      partition,
      groups: [...seen.groups].sort(),
      instances: [...seen.instances].sort(),
    }))
    .sort((a, b) => a.partition.localeCompare(b.partition));

  return {
    supported: true,
    workflows,
    otherPartitions,
    detail: describeDirectory(workflows, otherPartitions, mine),
  };
}

/** A few names plus a count, for prose. Route-by-handler gives every step its own queue, so one
 *  partitioned worker can be beating on dozens of tokens and inlining them all makes the sentence
 *  unreadable — measured at 17 on a single live worker. The complete list stays on
 *  {@link PartitionSighting.groups}, where a caller that wants it can read it in full. */
function summarize(names: readonly string[], limit = 3): string {
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

/** The one sentence a picker shows. Says which of the states the reader is in, and — when nothing is
 *  callable but something IS beating elsewhere — names the partition, because that is the difference
 *  between "start a worker" and "the worker you started is on the wrong partition". */
function describeDirectory(
  workflows: readonly AnnouncedWorkflow[],
  otherPartitions: readonly PartitionSighting[],
  namespace: string | undefined,
): string {
  const here = namespace === undefined ? 'this deployment' : `partition "${namespace}"`;
  const elsewhere =
    otherPartitions.length === 0
      ? ''
      : ` Live workers were seen on ${otherPartitions
          .map((p) => `"${p.partition}" (${summarize(p.groups)})`)
          .join(
            ', ',
          )}, which ${here} does not route to — a worker on the wrong partition looks exactly like no worker at all, so it is named here rather than left out.`;

  if (workflows.length === 0) {
    return `The fleet was asked just now and nothing is live in ${here}, so this list is empty because the deployment is empty — not because the question could not be put.${elsewhere}`;
  }
  const observed = workflows.filter((w) => w.evidence === 'observed').length;
  const declaredNote =
    observed === 0
      ? ''
      : ` ${observed} of them ${observed === 1 ? 'is' : 'are'} known only from a live queue: the worker serving ${observed === 1 ? 'it' : 'them'} publishes no description, so ${observed === 1 ? 'its' : 'their'} version, origin and runtime are genuinely unknown and a version pinned against ${observed === 1 ? 'it' : 'them'} cannot be checked.`;
  return `Every workflow a live worker in ${here} can execute, read just now. A worker that stops beating drops off this list within about half a minute.${declaredNote}${elsewhere}`;
}

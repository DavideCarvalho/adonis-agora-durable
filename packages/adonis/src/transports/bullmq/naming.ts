import { sanitizeQueueToken, tenantGroup } from '../../tenant-group.js';

/**
 * Broker naming for the aviary-compatible BullMQ transport — the byte-for-byte queue / channel / key
 * names a Python aviary worker (or a NestJS `BullMQTransport`) also computes, so a mixed-language
 * fleet lands on the SAME Redis keys. Every name is derived here and NOWHERE else, so a single place
 * owns the cross-SDK contract (see docs/superpowers/specs/2026-07-17-store-less-cluster-design.md §6.1).
 *
 * These are pure string builders (no Redis, no bullmq) so they unit-test in isolation and the wire
 * naming can be proven byte-identical to the golden fixtures without a broker.
 */

/** Re-exported so a caller computing a routing token uses the exact same sanitize/suffix rules. */
export { sanitizeQueueToken, tenantGroup };

/**
 * The prefix every name is built from, folding in the deployment namespace per the cross-SDK rule: a
 * set, non-`"default"` namespace appends `-<namespace>`; an unset or `"default"` namespace yields the
 * bare prefix (so the un-namespaced and `"default"` schemes are BYTE-IDENTICAL — production names
 * never change). Keep ALL name builders routed through this; a single direct `prefix` concat would
 * land a worker on a different queue than the engine and silently split the fleet.
 */
export function effectivePrefix(prefix: string, namespace: string | undefined): string {
  return namespace && namespace !== 'default' ? `${prefix}-${namespace}` : prefix;
}

/**
 * The final routing token a step/workflow `name` dispatches to / a worker subscribes on:
 * `tenantGroup(sanitizeQueueToken(name), partition)`. `:`→`-` (BullMQ forbids `:` in a queue name),
 * `.` kept, and a non-empty/non-`default` partition suffixes `@<partition>`. Apply IDENTICALLY at
 * dispatch and subscribe or a step routes to one token and is served from another (silently never run).
 */
export function routingToken(name: string, partition: string | undefined): string {
  return tenantGroup(sanitizeQueueToken(name), partition);
}

/** `${P}-tasks-${token}` — the per-routing-token task queue (jobs `task` / `workflow`). */
export function tasksName(effPrefix: string, token: string): string {
  return `${effPrefix}-tasks-${token}`;
}

/** `${P}-results` — the shared step-result queue (job `result`). */
export function resultsName(effPrefix: string): string {
  return `${effPrefix}-results`;
}

/**
 * The queue of step-result batches: one job carries many results (`{ results: StepResult[] }`). A
 * separate queue from {@link resultsName}, which only engines that read batches consume, so an engine
 * that reads one result per job never receives a batch.
 */
export function resultBatchesName(effPrefix: string): string {
  return `${effPrefix}-results-batch`;
}

/**
 * `${P}-results-to-${instance}` — the step results routed back to the engine instance that dispatched
 * them (jobs `result` / `results`, see `RemoteTask.replyTo`). The instance id is sanitized like the
 * NestJS transport and the Python worker sanitize it, so all three address the same queue.
 */
export function replyQueueName(effPrefix: string, instanceId: string): string {
  return `${effPrefix}-results-to-${instanceId.replace(/[^A-Za-z0-9_.@-]/g, '-')}`;
}

/** `${P}:reply-alive:${instance}` — set while that engine instance consumes its routed results. */
export function replyAliveKey(effPrefix: string, instanceId: string): string {
  return `${effPrefix}:reply-alive:${instanceId}`;
}

/** `${P}:reply-instances` — every engine instance that consumed or was sent routed results. */
export function replyInstancesKey(effPrefix: string): string {
  return `${effPrefix}:reply-instances`;
}

/** `${P}-decisions` — the workflow-decision queue (job `decision`). */
export function decisionsName(effPrefix: string): string {
  return `${effPrefix}-decisions`;
}

/** `${P}-step-events` — the streamed local-step-lifecycle queue (job `stepEvent`). */
export function stepEventsName(effPrefix: string): string {
  return `${effPrefix}-step-events`;
}

/** `${P}-heartbeat` — the run / long-step liveness pub/sub channel. */
export function heartbeatChannel(effPrefix: string): string {
  return `${effPrefix}-heartbeat`;
}

/**
 * `${P}-control` — the control-plane broadcast channel. The transport does NOT publish/subscribe it:
 * the shipped `RedisControlPlane` owns the control plane and builds its channel from this, so the one
 * place that knows the naming contract stays authoritative.
 */
export function controlChannel(effPrefix: string): string {
  return `${effPrefix}-control`;
}

/** `${P}-start-run` — the queue a store-less tenant enqueues start-run requests on (job `startRun`). */
export function startRunName(effPrefix: string): string {
  return `${effPrefix}-start-run`;
}

/** `${P}-runs` — the run queue every driving engine consumes (job `run`, a {@link RunDispatch}). */
export function runsName(effPrefix: string): string {
  return `${effPrefix}-runs`;
}

/**
 * The BullMQ job id of a run's `start` dispatch for one pending state (its `RunDispatch.key`):
 * a start re-sent for the same state while the first one waits or runs is not queued twice, and a
 * start for a new state (a retry while the previous job is still active) gets a job of its own.
 * BullMQ refuses an id that parses as an integer or holds a `:`, so the id is prefixed and `%`/`:` are
 * escaped.
 */
export function runStartJobId(runId: string, key: string): string {
  const esc = (v: string) => v.replaceAll('%', '%25').replaceAll(':', '%3A');
  return `start-${esc(runId)}-${esc(key)}`;
}

/** `${P}-run-request` — the queue a store-less tenant enqueues read/control requests on (job `runRequest`). */
export function runRequestName(effPrefix: string): string {
  return `${effPrefix}-run-request`;
}

/** `${P}-run-reply` — the shared pub/sub channel the control plane publishes {@link RunReply}s on;
 *  every tenant subscribes and filters by `requestId` client-side. */
export function runReplyChannel(effPrefix: string): string {
  return `${effPrefix}-run-reply`;
}

/** `${P}-tenant-events-${tenant}` — the per-tenant pub/sub channel the control plane re-publishes a
 *  tenant's lifecycle events on, so a store-less tenant live-tails only ITS OWN runs. */
export function tenantEventsChannel(effPrefix: string, tenant: string): string {
  return `${effPrefix}-tenant-events-${tenant}`;
}

/** Common prefix of every worker-liveness key (used to SCAN for live routing tokens). */
export function workerHeartbeatKeyPrefix(effPrefix: string): string {
  return `${effPrefix}-worker-heartbeat:`;
}

/**
 * `${P}-worker-heartbeat:${token}:${instanceId}` — one TTL'd liveness key per (routing token,
 * instance). Its ABSENCE (expiry) is the "worker gone/stalled" signal a monitor watches. Neither the
 * token nor the instanceId carries a `:` here, so the token is the segment between the fixed prefix
 * and the next `:` — the parse `listWorkerGroups` relies on.
 */
export function workerHeartbeatKey(effPrefix: string, token: string, instanceId: string): string {
  return `${workerHeartbeatKeyPrefix(effPrefix)}${token}:${instanceId}`;
}

/**
 * Prefix of every full-descriptor key on a routing `token`: `${P}-worker-descriptor:${token}:` —
 * used to SCAN the live {@link import('../../handshake/descriptor.js').WorkerDescriptor}s a worker
 * runtime publishes per token (design §7.2). BYTE-IDENTICAL to the worker-runtime's `workerDescriptorKey`
 * layout (`${P}-worker-descriptor:<token>:<instance>`), computed here too so the transport reads the
 * descriptor keyspace without reaching into the worker subpath.
 */
export function workerDescriptorTokenPrefix(effPrefix: string, token: string): string {
  return `${effPrefix}-worker-descriptor:${token}:`;
}

/**
 * Prefix of the per-instance worker keys a single SCAN walk reads for compatibility with writers that
 * only write those keys: `${P}-worker-` covers both `${P}-worker-heartbeat:` and
 * `${P}-worker-descriptor:` (the walk filters on those two segments).
 */
export function legacyWorkerKeysPrefix(effPrefix: string): string {
  return `${effPrefix}-worker-`;
}

/** The two kinds of entry the worker registry holds. */
export type WorkerRegistryKind = 'heartbeats' | 'descriptors';

/**
 * `${P}-workers:<kind>:<token>`: one hash per routing token, one field per instance, each value
 * `{ expiresAt, value }`. `workers:` (plural, then `:`) never matches the `${P}-worker-heartbeat:*` /
 * `${P}-worker-descriptor:*` patterns older readers SCAN, nor the `${P}-worker-*` compatibility walk,
 * so an older reader never reads a hash as a key, and the walk never visits the hashes.
 */
export function workerRegistryHashKey(
  effPrefix: string,
  kind: WorkerRegistryKind,
  token: string,
): string {
  return `${effPrefix}-workers:${kind}:${token}`;
}

/** `${P}-workers:tokens`: sorted set of the routing tokens with a registry hash (score = expiry, ms). */
export function workerRegistryIndexKey(effPrefix: string): string {
  return `${effPrefix}-workers:tokens`;
}

/**
 * `${P}-workers:instances`: the worker registry, one hash per prefix with one field per writing
 * instance (`<instance>#<nonce>`), each listing the tokens it serves with their heartbeat and
 * descriptor values. Like the rc.31 per-token hashes it never matches the `${P}-worker-*` patterns
 * older readers SCAN.
 */
export function workerInstancesKey(effPrefix: string): string {
  return `${effPrefix}-workers:instances`;
}

/**
 * The partition a routing token carries (the part after its last `@`), or `undefined` for a bare
 * token. Grouped task queues are per partition, so a dispatcher and a consumer derive the same queue
 * from the token alone.
 */
export function tokenPartition(token: string): string | undefined {
  const at = token.lastIndexOf('@');
  return at === -1 ? undefined : token.slice(at + 1);
}

/**
 * `${P}-taskgroup` (or `${P}-taskgroup@<partition>`): the ONE task queue every handler of a partition
 * shares when the transport runs with `taskQueues: 'grouped'`. Jobs keep their `task` / `workflow`
 * name and carry their routing token in `data.group`, which is what the consumer routes on. It never
 * matches a per-handler `${P}-tasks-<token>` name, so the two layouts can live side by side while one
 * drains into the other.
 */
export function groupedTasksName(effPrefix: string, token: string): string {
  const partition = tokenPartition(token);
  return partition === undefined ? `${effPrefix}-taskgroup` : `${effPrefix}-taskgroup@${partition}`;
}

/**
 * The BullMQ keys that exist only while a queue holds unfinished work (Redis drops an empty list or
 * sorted set). `EXISTS` over them is how the transport learns, in one command for every queue at once,
 * whether a queue of the other layout still has jobs to drain.
 */
export function queueWorkKeys(bullPrefix: string, queueName: string): string[] {
  return ['wait', 'active', 'paused', 'delayed', 'prioritized', 'waiting-children'].map(
    (suffix) => `${bullPrefix}:${queueName}:${suffix}`,
  );
}

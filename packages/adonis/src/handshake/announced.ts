/**
 * The announced workflow registry (design §7.9) — the aggregate answer to "what workflows exist in
 * this deployment?", built ONLY from what live workers say about themselves: each worker publishes
 * what it can execute ({@link WorkerDescriptor.registrations}, or bare `workflows` names), and this
 * module folds those statements together. Every entry is a fact somebody asserted, and the aggregate
 * is the same on every pod because every pod reads the same published statements. Pure data, no I/O.
 */

import type { RawWorkerDescriptor, WorkerDescriptor, WorkflowRegistration } from './descriptor.js';
import { canonicalRoutes, normalizeDescriptor } from './descriptor.js';

/** One live worker's claim about one workflow: the registration plus who announced it. */
export interface WorkflowAnnouncement extends WorkflowRegistration {
  /** The announcing worker's instance id. */
  instanceId: string;
  /** The announcing worker's runtime — how a Python-served workflow is told from a Node-served one. */
  runtime: 'node' | 'python';
}

/** An axis on which the live announcers of one workflow do not agree. `values` holds every distinct
 *  DECLARED value (sorted); an announcer that stated nothing on the axis contributes nothing. */
export interface Disagreement {
  axis: 'group' | 'origin' | 'requires' | 'onError';
  values: string[];
}

/**
 * How strong the fleet's claim about a workflow is. The two tiers are NOT interchangeable and a
 * caller must not read them as the same fact:
 *
 * - `'declared'` — at least one live worker published a descriptor naming this workflow. Everything
 *   populated on the entry was STATED by that worker; everything absent it declined to state.
 * - `'observed'` — nobody described it. What exists is a live routing token of this name, which is
 *   precisely the condition `resolveRemoteByConvention` uses to route a call, so the name IS
 *   reachable. Nothing else is known: no version, no origin, no runtime, and no assurance that the
 *   worker consuming that token serves a WORKFLOW there rather than a step handler of the same name.
 *   An entry like this is a live queue, not a promise.
 */
export type AnnouncementEvidence = 'declared' | 'observed';

/** One workflow the live fleet announces, folded across every worker that announced it. */
export interface AnnouncedWorkflow {
  /** What kind of claim this entry rests on — see {@link AnnouncementEvidence}. A caller that shows
   *  a version, an origin or a runtime must check this first: an `'observed'` entry has none of
   *  them, and the emptiness is a fact about the fleet, not a rendering gap. */
  evidence: AnnouncementEvidence;
  /** `name@version`, or the bare `name` when no announcer stated a version. Stable sort key. */
  key: string;
  name: string;
  /** Absent when no announcer stated one — never inferred from another announcer's version. */
  version?: string;
  /** Every distinct routing group announced (sorted). Empty = nobody stated one. On an `'observed'`
   *  entry this is the token the heartbeat was published UNDER — not a claim by anybody, but the
   *  queue a call would actually land on, which is the one thing an observation does establish. */
  groups: string[];
  /** Every distinct declaring package announced (sorted). Empty = nobody stated one. */
  origins: string[];
  /** Every distinct capability demand announced, each de-duplicated + sorted. Empty = nobody stated
   *  one. Two entries here means two workers demand different capabilities for the same version. */
  requires: string[][];
  /** Every distinct set of `onError` routes announced, each in canonical order. Empty = nobody stated
   *  one. Two entries here means the live workers route this workflow's failures differently. */
  onError: { code?: string; workflow: string }[][];
  /** Runtimes of the live announcers (sorted, de-duplicated). EMPTY on an `'observed'` entry: a
   *  heartbeat does not say what runtime wrote it, and the instance id's shape is a convention, not
   *  a statement, so it is not read as one. */
  runtimes: ('node' | 'python')[];
  /** Instance ids of the live workers announcing it (sorted, de-duplicated). Its length is how many
   *  workers can currently run this workflow — `1` is a single point of failure, and it is never 0
   *  (an entry exists only because somebody announced it, or because somebody is beating on it). */
  instances: string[];
  /** The axes the announcers differ on, empty when they speak with one voice. A caller that must
   *  pick a single target has to resolve these itself — the registry refuses to guess. */
  disagreements: Disagreement[];
}

/**
 * What one descriptor announces. `registrations` is authoritative when present; any `workflows` name
 * it does not cover is still announced as a bare, unversioned claim, so a worker that describes some
 * of its workflows richly and others by name alone is reported in full rather than in part.
 *
 * A descriptor with neither field announces nothing — including the control plane's own descriptor,
 * which is a router, not an executor.
 */
export function announcementsOf(
  raw: RawWorkerDescriptor | WorkerDescriptor,
): WorkflowAnnouncement[] {
  const d = normalizeDescriptor(raw);
  const identity = { instanceId: d.instanceId, runtime: d.runtime };
  const announcements = (d.registrations ?? []).map((reg) => ({ ...reg, ...identity }));
  const covered = new Set(announcements.map((a) => a.name));
  for (const name of d.workflows) {
    if (!covered.has(name)) announcements.push({ name, ...identity });
  }
  return announcements;
}

/** `name@version`, or the bare name when unversioned — the identity two announcements are folded on. */
function announcementKey(a: WorkflowRegistration): string {
  return a.version === undefined ? a.name : `${a.name}@${a.version}`;
}

/** Sorted, de-duplicated members of `values`, dropping the un-stated ones. */
function stated(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== undefined))].sort();
}

/**
 * Fold every live descriptor's announcements into one entry per `name@version`, sorted by key.
 *
 * Pure: it holds nothing and caches nothing, so no pod ever carries a growing table of the fleet's
 * registrations — the caller reads the live descriptors it already knows how to read, folds them
 * here, and drops the result. The work is O(descriptors × announcements) per call, on demand.
 *
 * The same instance announcing the same workflow twice (a worker publishes its descriptor under
 * every routing token it consumes, so the same bytes arrive several times) folds to ONE announcer:
 * `instances` is a set, so it counts workers, not keys.
 */
export function aggregateAnnouncements(
  descriptors: readonly (RawWorkerDescriptor | WorkerDescriptor)[],
): AnnouncedWorkflow[] {
  const byKey = new Map<string, WorkflowAnnouncement[]>();
  for (const descriptor of descriptors) {
    for (const announcement of announcementsOf(descriptor)) {
      const key = announcementKey(announcement);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(announcement);
      else byKey.set(key, [announcement]);
    }
  }

  const out: AnnouncedWorkflow[] = [];
  for (const [key, announcements] of byKey) {
    const groups = stated(announcements.map((a) => a.group));
    const origins = stated(announcements.map((a) => a.origin));
    // A capability demand is a SET, so it is compared as its canonical (sorted, de-duplicated) form:
    // two workers demanding ['saga','signals'] and ['signals','saga'] agree, and must not be reported
    // as a disagreement over the same demand written two ways.
    const requiresByJson = new Map<string, string[]>();
    for (const a of announcements) {
      if (a.requires === undefined) continue;
      const canonical = [...new Set(a.requires)].sort();
      requiresByJson.set(JSON.stringify(canonical), canonical);
    }
    // Ordered by the same rendering `disagreements` uses, so the two lists read in step.
    const requires = [...requiresByJson.values()].sort((x, y) =>
      x.join(',').localeCompare(y.join(',')),
    );

    const routesByJson = new Map<string, { code?: string; workflow: string }[]>();
    for (const a of announcements) {
      if (a.onError === undefined) continue;
      const canonical = canonicalRoutes(a.onError).map((r) =>
        r.code === null ? { workflow: r.workflow } : { code: r.code, workflow: r.workflow },
      );
      routesByJson.set(JSON.stringify(canonical), canonical);
    }
    const onError = [...routesByJson.keys()].sort().map((k) => routesByJson.get(k) ?? []);

    const disagreements: Disagreement[] = [];
    if (groups.length > 1) disagreements.push({ axis: 'group', values: groups });
    if (origins.length > 1) disagreements.push({ axis: 'origin', values: origins });
    if (requires.length > 1) {
      disagreements.push({ axis: 'requires', values: requires.map((r) => r.join(',')) });
    }
    if (onError.length > 1) {
      disagreements.push({ axis: 'onError', values: [...routesByJson.keys()].sort() });
    }

    const first = announcements[0];
    if (!first) continue;
    out.push({
      evidence: 'declared',
      key,
      name: first.name,
      ...(first.version !== undefined ? { version: first.version } : {}),
      groups,
      origins,
      requires,
      onError,
      runtimes: [...new Set(announcements.map((a) => a.runtime))].sort(),
      instances: [...new Set(announcements.map((a) => a.instanceId))].sort(),
      disagreements,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

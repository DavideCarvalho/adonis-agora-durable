/**
 * Worker/control-plane handshake descriptor — the single source of truth for routing, compatibility
 * and observability across a store-less durable cluster (design §7.1). Pure data + a deterministic,
 * order-insensitive content hash; NO transport, NO I/O. Every field is part of the cross-language
 * wire contract (the nestjs + python SDKs build the byte-identical shape, design §7.8).
 */

/**
 * One workflow a worker ANNOUNCES it can execute — the richer form of a `workflows` name.
 *
 * The rule is "announce only what you can run": a process publishes a registration for a workflow
 * whose body it holds and whose queue it consumes. It never publishes one for a workflow it merely
 * knows how to *route to* (an engine's `registerRemote`), because that claim says nothing about a
 * live executor existing — which is precisely the ambiguity an aggregate registry has to remove.
 *
 * Every field but `name` is optional because the SDKs hold different amounts of this. A worker that
 * knows only names (the Python `@worker.workflow("x")` form, or any pre-registrations SDK) publishes
 * bare `workflows` names instead and is still a first-class announcer — see {@link WorkerDescriptor.registrations}.
 * A reader must therefore treat an absent field as "not stated", never as a value: the aggregate in
 * `./announced` never invents a version, a group or an origin that nobody announced.
 */
export interface WorkflowRegistration {
  /** Registered workflow name — the `workflow` a `WorkflowTask` carries. */
  name: string;
  /** Registered version, when the announcer knows one. Absent = unversioned announcement. */
  version?: string;
  /** The routing token this workflow's turns are dispatched to (the queue this worker consumes for
   *  it). Absent = the announcer did not say; a reader must NOT assume the by-convention token. */
  group?: string;
  /** Capabilities a worker must advertise to run it (design §7.5), as the announcer declares them. */
  requires?: string[];
  /** The package that DECLARED the workflow (see `WorkflowRun.origin`). Absent = no package (`app`); nothing
   *  ever substitutes a default, because a wrong origin is worse than no origin. */
  origin?: string;
  /**
   * Where the engine routes a failed run of this workflow, by error `code` (`code` absent = the
   * catch-all): the handler workflow it starts instead of failing the run. The one announced field
   * the engine ACTS on, for a workflow it serves by convention rather than by local registration.
   * Absent = not stated, which routes nothing.
   */
  onError?: { code?: string; workflow: string }[];
}

/**
 * A worker's (or control-plane's) advertised identity, wire-protocol support, feature capabilities
 * and registered handlers. Published on startup + on change (design §7.2) and consumed by
 * {@link negotiate} (compat) and the capability-aware router (design §7.5). Exactly the §7.1 shape.
 */
export interface WorkerDescriptor {
  /** Stable id for this process in the fleet (mirrors aviary's per-instance heartbeat key). */
  instanceId: string;
  /** Execution runtime — a `python` worker and a `node` control-plane interoperate over the wire. */
  runtime: 'node' | 'python';
  /** Which SDK + version produced this descriptor. Observability only; never gates dispatch. */
  sdk: { name: string; version: string };
  /**
   * Wire-protocol majors this side speaks. `version` is its preferred/current major; `range` is the
   * inclusive `[min, max]` band it can negotiate down/up to. Overlap of two ranges is what makes two
   * sides compatible (design §7.4); `version` is informational.
   */
  protocol: { version: number; range: [number, number] };
  /** Named features advertised: `'saga'`, `'signals'`, `'search-attr-v2'`, `'priority'`, … A modern
   *  worker MAY advertise `[]` (no named features); an ABSENT field means "legacy v1" — see
   *  {@link normalizeDescriptor}. Order-insensitive: treated as a set. */
  capabilities: string[];
  /** Registered workflow handler names → routing targets. Order-insensitive (a set). */
  workflows: string[];
  /** Registered step handler names → routing targets. Order-insensitive (a set). */
  steps: string[];
  /**
   * The richer, per-workflow ANNOUNCEMENT of what this instance can execute (name + version + group
   * + requires + origin). OPTIONAL and purely additive: an SDK that has only names keeps publishing
   * {@link workflows} and is aggregated all the same, just unversioned. An SDK that publishes this
   * SHOULD also list the same names in {@link workflows}, so a reader that predates this field still
   * sees the workflow at all.
   *
   * It rides the descriptor rather than a registry of its own so it inherits the whole liveness
   * story for free: the descriptor key is written with the heartbeat's TTL and refreshed by the same
   * beat, so an announcement from a worker that has since died EXPIRES instead of offering a choice
   * that fails at run time.
   */
  registrations?: WorkflowRegistration[];
  /** Optional routing partition (queue/group sharding). */
  partition?: string;
  /** Optional tenant namespace this instance serves. */
  namespace?: string;
  /** Process start time (epoch ms) — a restart changes it, so it participates in the content hash. */
  startedAt: number;
}

/**
 * The current wire-protocol major. The whole protocol as it exists today is defined as **v1**; the
 * handshake exists so a future **v2 breaking change** is detectable rather than silently corrupting
 * (design §7.7).
 */
export const CURRENT_PROTOCOL_VERSION = 1;

/**
 * The protocol band assumed for a descriptor that omits `protocol` entirely — an existing aviary
 * worker that predates the handshake. Absence = **legacy v1 baseline, assume compatible** (§7.7).
 */
export const LEGACY_V1_PROTOCOL: WorkerDescriptor['protocol'] = { version: 1, range: [1, 1] };

/**
 * The feature set a legacy (pre-handshake) worker is assumed to advertise when its `capabilities`
 * field is ABSENT. These are the durable primitives that have existed since v1, so a legacy worker
 * can still be routed work that `requires` them (design §7.5/§7.7).
 *
 * This is the canonical aviary v1 execution surface, byte-for-byte identical across the Adonis,
 * nestjs-durable, and Python SDKs (verified against the aviary codebase). `search-attr-v2` and other
 * modern features are layered ON TOP and are NOT part of the v1 baseline — a legacy worker guarantees
 * only the v1 `search-attributes` surface. Keep this list in lockstep with the other two SDKs.
 */
export const LEGACY_V1_CAPABILITIES: readonly string[] = Object.freeze([
  'saga',
  'signals',
  'search-attributes',
  'priority',
  'entities',
  'child-workflows',
  'singleton',
  'schedules',
  'continue-as-new',
  'queries',
  'cancellation',
]);

/**
 * A raw, possibly-partial descriptor as it may arrive off the wire from an older SDK: `protocol`
 * and/or `capabilities` may be missing. {@link normalizeDescriptor} fills the legacy-v1 defaults.
 */
export type RawWorkerDescriptor = Omit<Partial<WorkerDescriptor>, 'instanceId' | 'runtime'> & {
  instanceId: string;
  runtime: 'node' | 'python';
};

/**
 * True when a descriptor predates the handshake — it carries no `protocol` field. Such a descriptor
 * is treated as legacy v1 and assumed compatible (design §7.7).
 */
export function isLegacyDescriptor(raw: RawWorkerDescriptor | WorkerDescriptor): boolean {
  return (raw as Partial<WorkerDescriptor>).protocol === undefined;
}

/**
 * Fill legacy-v1 defaults so downstream logic always sees a complete {@link WorkerDescriptor}:
 * - absent `protocol` → {@link LEGACY_V1_PROTOCOL} (assume-compatible v1 baseline),
 * - absent `capabilities` → {@link LEGACY_V1_CAPABILITIES} (a modern `[]` is preserved as-is),
 * - absent `workflows`/`steps` → `[]`, absent `sdk` → an `unknown` marker, absent `startedAt` → `0`.
 *
 * The undefined-vs-`[]` distinction is deliberate: an absent field means "legacy, doesn't advertise
 * this axis"; an explicit empty array means "modern SDK that genuinely advertises nothing".
 */
export function normalizeDescriptor(raw: RawWorkerDescriptor | WorkerDescriptor): WorkerDescriptor {
  return {
    instanceId: raw.instanceId,
    runtime: raw.runtime,
    sdk: raw.sdk ?? { name: 'unknown', version: '0' },
    protocol: raw.protocol ?? { ...LEGACY_V1_PROTOCOL },
    capabilities: raw.capabilities ?? [...LEGACY_V1_CAPABILITIES],
    workflows: raw.workflows ?? [],
    steps: raw.steps ?? [],
    ...(raw.registrations !== undefined ? { registrations: raw.registrations } : {}),
    ...(raw.partition !== undefined ? { partition: raw.partition } : {}),
    ...(raw.namespace !== undefined ? { namespace: raw.namespace } : {}),
    startedAt: raw.startedAt ?? 0,
  };
}

/**
 * Compact, liveness lifecycle status carried on the cheap steady-state heartbeat (design §7.2).
 * Distinct from aviary's rich `WorkerStatus` object (owned by the transport layer): this is the
 * lightweight two-tier advertisement, whose job is to carry the {@link descriptorHash} ETag.
 */
export type WorkerLifecycle = 'up' | 'draining' | 'quiescing' | 'stopped';

/**
 * The two-tier heartbeat payload (design §7.2): a cheap `{ ts, status, descriptorHash }` beaten every
 * ~10s. The `descriptorHash` is an **ETag** — the control-plane re-reads the full (expensive)
 * descriptor only when this hash changes, keeping steady-state chatter tiny.
 */
export interface HeartbeatStatus {
  /** Beat time, epoch ms. */
  ts: number;
  /** Compact lifecycle status. */
  status: WorkerLifecycle;
  /** ETag over the full descriptor — see {@link descriptorHash}. */
  descriptorHash: string;
}

/**
 * Canonical, order-insensitive projection of the `registrations` announcement: each entry gets a
 * FIXED key order with absent fields collapsed to `null` (so present-with-undefined and absent
 * agree), `requires` sorted + de-duplicated, and the entries themselves de-duplicated and sorted by
 * their own canonical JSON. Announcement order therefore cannot change the hash — only the announced
 * CONTENT can, which is exactly when a control plane should re-read.
 */
function canonicalizeRegistrations(regs: readonly WorkflowRegistration[]): unknown[] {
  const canonical = regs.map((r) => ({
    name: r.name,
    version: r.version ?? null,
    group: r.group ?? null,
    requires: r.requires ? [...new Set(r.requires)].sort() : null,
    origin: r.origin ?? null,
    // Conditional, so a registration that states no routes keeps the hash it had before routes existed.
    ...(r.onError !== undefined ? { onError: canonicalRoutes(r.onError) } : {}),
  }));
  const byJson = new Map<string, unknown>();
  for (const entry of canonical) byJson.set(JSON.stringify(entry), entry);
  return [...byJson.keys()].sort().map((k) => byJson.get(k));
}

/** Routes in a fixed key order, de-duplicated and sorted, so their order never changes the hash. */
export function canonicalRoutes(
  routes: readonly { code?: string; workflow: string }[],
): { code: string | null; workflow: string }[] {
  const byJson = new Map<string, { code: string | null; workflow: string }>();
  for (const r of routes) {
    const entry = { code: r.code ?? null, workflow: r.workflow };
    byJson.set(JSON.stringify(entry), entry);
  }
  return [...byJson.keys()]
    .sort()
    .map((k) => byJson.get(k) as { code: string | null; workflow: string });
}

/** Canonical, order-insensitive projection of a descriptor used for hashing. The three set-valued
 *  fields are sorted + de-duplicated so member order can never change the hash; scalar fields are
 *  taken verbatim; optional fields collapse to `null` so present-with-undefined and absent agree. */
function canonicalizeForHash(d: WorkerDescriptor): unknown {
  const set = (xs: string[]): string[] => [...new Set(xs)].sort();
  // Keys are emitted in a FIXED order (this literal's order) so the stringify below is stable
  // regardless of the input object's key insertion order.
  return {
    instanceId: d.instanceId,
    runtime: d.runtime,
    sdk: { name: d.sdk.name, version: d.sdk.version },
    protocol: { version: d.protocol.version, range: [d.protocol.range[0], d.protocol.range[1]] },
    capabilities: set(d.capabilities),
    workflows: set(d.workflows),
    steps: set(d.steps),
    // Conditional, so a descriptor that announces nothing keeps the hash it had before this field.
    ...(d.registrations !== undefined
      ? { registrations: canonicalizeRegistrations(d.registrations) }
      : {}),
    partition: d.partition ?? null,
    namespace: d.namespace ?? null,
    startedAt: d.startedAt,
  };
}

/**
 * Deterministic 64-bit FNV-1a hash of a string → 16-char lowercase hex. Chosen over a crypto digest
 * because it is trivially reproducible in every SDK (TS/Python/…) with no dependency, keeping the
 * ETag scheme portable for cross-language conformance (design §7.8).
 */
function fnv1a64Hex(input: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    // charCodeAt can exceed a byte; fold the high byte in too so non-ASCII still contributes.
    hash ^= BigInt((input.charCodeAt(i) >> 8) & 0xff);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Stable ETag over a descriptor's content (design §7.2). **Order-insensitive** over the set-valued
 * fields (`capabilities`/`workflows`/`steps`) — the same members in any order yield the same hash —
 * and stable across the object's key insertion order. Any change to a routing/compat-relevant field
 * (including `startedAt` on restart) changes the hash, which is what triggers a full re-read.
 *
 * Accepts a raw/partial descriptor too: it is normalized first, so a legacy descriptor hashes as its
 * v1 baseline.
 */
export function descriptorHash(descriptor: RawWorkerDescriptor | WorkerDescriptor): string {
  const canonical = canonicalizeForHash(normalizeDescriptor(descriptor));
  return fnv1a64Hex(JSON.stringify(canonical));
}

/**
 * Build the compact two-tier heartbeat for a descriptor, stamping the ETag (design §7.2). `ts`
 * defaults to now and `status` to `'up'`.
 */
export function heartbeatStatus(
  descriptor: RawWorkerDescriptor | WorkerDescriptor,
  opts: { ts?: number; status?: WorkerLifecycle } = {},
): HeartbeatStatus {
  return {
    ts: opts.ts ?? Date.now(),
    status: opts.status ?? 'up',
    descriptorHash: descriptorHash(descriptor),
  };
}

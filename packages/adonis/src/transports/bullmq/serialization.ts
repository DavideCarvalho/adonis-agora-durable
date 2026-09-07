import { hostname } from 'node:os';

/**
 * Serialization for the aviary-compatible BullMQ transport — the byte-for-byte job options, priority
 * mapping, instance id and worker-heartbeat value a Python aviary worker (or a NestJS
 * `BullMQTransport`) also produce/consume. Pure (no bullmq, no Redis) so the wire contract is proven
 * against the golden fixtures without a broker.
 *
 * The wire DTOs themselves (`RemoteTask`/`StepResult`/`Heartbeat`/`WorkflowTask`/…) cross the queue
 * as PLAIN JSON with NO envelope — the DTO **is** the BullMQ job's `data` (BullMQ `JSON.stringify`s it
 * into the job hash). Their dates are already epoch-ms numbers and their optionals are omitted when
 * absent, so a straight `queue.add(jobName, dto, opts)` is byte-identical across SDKs; there is no
 * transform to apply here beyond the job OPTIONS below.
 */

// BullMQ priority is the INVERSE of the durable engine's: BullMQ runs the LOWEST number first
// (1..2_097_151), while the engine's admission `priority` is "higher wins". Translate so one
// convention ("higher = more urgent") holds end-to-end. `BASELINE - p` keeps relative order (a higher
// `p` yields a lower — more urgent — BullMQ number), clamped into BullMQ's valid range, centred on the
// range midpoint so callers have headroom both above and below the default.
const BROKER_PRIORITY_MAX = 2_097_151;
const BROKER_PRIORITY_BASELINE = 1_048_576;

/**
 * Map the engine's per-call `priority` (higher = more urgent, default/absent = unprioritised) onto a
 * BullMQ job `priority` (lower = more urgent). Returns `undefined` for an absent priority so the
 * default FIFO path is untouched. `clamp(round(1_048_576 - priority), 1, 2_097_151)` — byte-identical
 * to the aviary transport (spec §6.3).
 */
export function toBrokerPriority(priority?: number): number | undefined {
  if (priority == null) return undefined;
  const mapped = Math.round(BROKER_PRIORITY_BASELINE - priority);
  return Math.min(BROKER_PRIORITY_MAX, Math.max(1, mapped));
}

/** Worker-liveness heartbeat cadence: refresh every 10s, key TTL 35s (comfortably > interval so one
 *  slow refresh doesn't flap). Matches the aviary/Python `_HEARTBEAT_*` constants. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_TTL_SECONDS = 35;

/** How long a FAILED task job's payload is retained before BullMQ GCs it — long enough for a peer's
 *  stalled-check + the terminal-failure bridge to read its `RemoteTask`, bounded so failures don't
 *  accumulate. 24h, matching aviary's `TASK_FAILED_RETENTION_SECONDS`. */
export const TASK_FAILED_RETENTION_SECONDS = 24 * 60 * 60;

// Epoch values below this are seconds (Python's `time.time()`), at/above are milliseconds (the TS
// SDKs). Normalise to ms. ~1e12 ms ≈ year 2001; ~1e12 s is year 33658 — unambiguous.
const EPOCH_MS_THRESHOLD = 1e12;

/**
 * Stable per-process id stamped on the worker-heartbeat keys: `ts-<host>-<pid>` (the Python SDK uses
 * `py-<host>-<pid>`), so N replicas of a group each show as a distinct worker and a reader can tell
 * which runtime a worker is. Args are injectable for a deterministic test.
 */
export function buildInstanceId(host: string = hostname(), pid: number = process.pid): string {
  return `ts-${host}-${pid}`;
}

/** BullMQ `add` options for a NON-task job (result/decision/stepEvent): `removeOnComplete`/
 *  `removeOnFail` both `true` (spec §6.3), plus a translated `priority` only when set. */
export interface JobOptions {
  removeOnComplete: true;
  removeOnFail: true;
  priority?: number;
}

export function jobOptions(priority?: number): JobOptions {
  const brokerPriority = toBrokerPriority(priority);
  return {
    removeOnComplete: true,
    removeOnFail: true,
    ...(brokerPriority != null ? { priority: brokerPriority } : {}),
  };
}

/** BullMQ `add` options for a TASK job (step/workflow dispatch): like {@link jobOptions} but
 *  `removeOnFail` is age-bounded retention (`{ age: 86400 }`) so a crashed worker's failed job keeps
 *  its `RemoteTask` payload long enough for the terminal-failure bridge to rebuild a StepResult. */
export interface TaskJobOptions {
  removeOnComplete: true;
  removeOnFail: { age: number };
  priority?: number;
}

export function taskJobOptions(priority?: number): TaskJobOptions {
  const brokerPriority = toBrokerPriority(priority);
  return {
    removeOnComplete: true,
    removeOnFail: { age: TASK_FAILED_RETENTION_SECONDS },
    ...(brokerPriority != null ? { priority: brokerPriority } : {}),
  };
}

/**
 * The value written to a worker-liveness key: JSON `{"ts": <epochMs>}`. Epoch MILLISECONDS (readers
 * normalise seconds→ms only as a legacy fallback). Byte-compatible with the Python worker's minimal
 * form and accepted by the aviary reader (which tolerates a missing `status`).
 */
export function heartbeatKeyValue(nowMs: number = Date.now(), status?: unknown): string {
  return JSON.stringify(status === undefined ? { ts: nowMs } : { ts: nowMs, status });
}

/**
 * Parse a worker-heartbeat key value into `{ lastBeatAt }`, accepting BOTH the `{"ts":…}` JSON (this
 * SDK / newer SDKs) and an older bare timestamp string (the Python SDK's seconds / a legacy ms value).
 * A bare number or a `ts` below {@link EPOCH_MS_THRESHOLD} is treated as seconds and scaled to ms.
 * Robust to a missing/garbled value (→ `lastBeatAt: 0`).
 */
export function parseHeartbeatValue(raw: string | null): {
  lastBeatAt: number;
  status?: Record<string, unknown> | undefined;
} {
  if (raw == null) return { lastBeatAt: 0 };
  const trimmed = raw.trim();
  if (trimmed === '') return { lastBeatAt: 0 };

  const toMs = (n: number): number =>
    Number.isFinite(n) ? (n < EPOCH_MS_THRESHOLD ? n * 1000 : n) : 0;

  // Old bare-number form (no JSON braces): a plain ms/seconds timestamp.
  if (!trimmed.startsWith('{')) return { lastBeatAt: toMs(Number(trimmed)) };

  try {
    const parsed = JSON.parse(trimmed) as { ts?: unknown; status?: unknown };
    const status =
      parsed.status !== null && typeof parsed.status === 'object'
        ? (parsed.status as Record<string, unknown>)
        : undefined;
    return {
      lastBeatAt: typeof parsed.ts === 'number' ? toMs(parsed.ts) : 0,
      ...(status !== undefined ? { status } : {}),
    };
  } catch {
    // Malformed JSON — fall back to a numeric read so a partially-written value still yields a beat.
    return { lastBeatAt: toMs(Number(trimmed)) };
  }
}

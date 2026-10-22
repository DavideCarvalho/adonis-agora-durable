import type { WorkerDescriptor } from '../handshake/descriptor.js';
import type { DescriptorRedis } from '../worker-runtime/registry.js';

/**
 * The worker advertisement keyspace (design §7.2) for a transport with no Redis: the
 * `${P}-worker-descriptor:<token>:<instance>` and `${P}-worker-heartbeat:<token>:<instance>` keys a
 * {@link import('../worker-runtime/worker-runtime.js').WorkerRuntime} writes, each with an expiry, so a
 * worker that dies without a clean stop drops out once its last write expires — the same liveness the
 * Redis `SET … EX` keys give the BullMQ transport.
 */
export interface WorkerKeyStore {
  /** Write `key`, live until `expiresAt` (epoch ms). Overwrites. */
  put(key: string, value: string, expiresAt: number): Promise<void>;
  /** Remove `keys` (a clean stop). */
  remove(keys: string[]): Promise<void>;
  /** Every key still live at `now`, with its value. */
  live(now: number): Promise<{ key: string; value: string }[]>;
}

const DESCRIPTOR_SEGMENT = '-worker-descriptor:';
const HEARTBEAT_SEGMENT = '-worker-heartbeat:';

/**
 * The {@link DescriptorRedis} port the worker registry writes through, over a {@link WorkerKeyStore}:
 * `set(key, value, 'EX', ttl)` becomes a put live for `ttl` seconds.
 */
export function workerKeyWriter(store: WorkerKeyStore, now: () => number): DescriptorRedis {
  return {
    set: (key, value, _mode, ttl) => store.put(key, value, now() + ttl * 1000),
    del: (...keys) => store.remove(keys),
  };
}

/** The live descriptors advertised on `token`. A malformed value reads as absent. */
export function descriptorsOn(
  entries: readonly { key: string; value: string }[],
  token: string,
): WorkerDescriptor[] {
  const marker = `${DESCRIPTOR_SEGMENT}${token}:`;
  const descriptors: WorkerDescriptor[] = [];
  for (const { key, value } of entries) {
    if (!key.includes(marker)) continue;
    try {
      descriptors.push(JSON.parse(value) as WorkerDescriptor);
    } catch {
      /* a malformed descriptor never blocks routing — treat it as absent */
    }
  }
  return descriptors;
}

/** The routing tokens with at least one live worker heartbeat. */
export function liveGroupsOf(entries: readonly { key: string }[]): string[] {
  const groups = new Set<string>();
  for (const { key } of entries) {
    const at = key.indexOf(HEARTBEAT_SEGMENT);
    if (at === -1) continue;
    const rest = key.slice(at + HEARTBEAT_SEGMENT.length);
    const sep = rest.indexOf(':');
    const group = sep === -1 ? rest : rest.slice(0, sep);
    if (group) groups.add(group);
  }
  return [...groups];
}

/** A {@link WorkerKeyStore} held in memory, for transports whose workers share the process. */
export class MemoryWorkerKeys implements WorkerKeyStore {
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();

  async put(key: string, value: string, expiresAt: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt });
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.#entries.delete(key);
  }

  async live(now: number): Promise<{ key: string; value: string }[]> {
    const out: { key: string; value: string }[] = [];
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt > now) out.push({ key, value: entry.value });
      else this.#entries.delete(key);
    }
    return out;
  }
}

import { inboxKey, tenantSubscriberKey, tenantSubscriberKeyPrefix } from './queue-remote.js';
import { cachedLiveKeys, type WorkerKeyStore } from './worker-keys.js';

/**
 * The live-subscriber registry of the db transport's store-less protocol. Run replies, tenant events
 * and remote-workflow decisions are rows of the messages table addressed to ONE instance (its
 * `recipient`); this tracks who is there to address them to, in the worker-key table every db instance
 * already reads and writes:
 *
 * - `${P}-inbox:<instance>` — "this instance is alive and consuming its addressed rows". Written by
 *   every instance that consumes an inbox (a requester waiting for replies, a tenant-event subscriber,
 *   an engine waiting for decisions).
 * - `${P}-tenant-subscriber:<tenant>:<instance>` — "this instance wants `tenant`'s events". A publisher
 *   writes one row per live subscriber of the event's tenant.
 *
 * Both live for {@link DbInboxRegistryOptions.ttlMs} and are re-written every third of it. Unlike the
 * queue transport, a subscriber writes its keys itself — a pod on the db transport reaches the same
 * database as the control plane by definition, so there is no announcement to relay. Key names are the
 * queue transport's (`queue-remote.ts`): URI-encoded tenant and instance segments, so a tenant name
 * containing `:` can never match another tenant's keys.
 */

/** Default TTL (ms) of the subscriber and inbox keys; re-written every third of it. */
export const DEFAULT_DB_INBOX_TTL_MS = 30_000;
/** Default reuse window (ms) of a publisher's read of the live tenant subscribers. */
export const DEFAULT_DB_TENANT_SUBSCRIBERS_CACHE_MS = 1_000;
/** Default cadence (ms) of the janitor that deletes rows addressed to instances that are gone. */
export const DEFAULT_DB_INBOX_SWEEP_INTERVAL_MS = 30_000;

export interface DbInboxRegistryOptions {
  store: () => WorkerKeyStore;
  /** The effective key prefix, read on every use (the namespace can be adopted after construction). */
  prefix: () => string;
  instanceId: string;
  ttlMs: number;
  subscribersCacheMs: number;
  onError: (err: unknown) => void;
  now?: () => number;
}

const ownerOf = (value: string): string | undefined => {
  try {
    const parsed = JSON.parse(value) as { instanceId?: unknown };
    return typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined;
  } catch {
    return undefined;
  }
};

export class DbInboxRegistry {
  readonly #options: DbInboxRegistryOptions;
  readonly #now: () => number;
  readonly #tenants = new Set<string>();
  #inboxActive = false;
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** Key writes in flight — `close()` lets them land before removing the keys. */
  readonly #writes = new Set<Promise<void>>();
  #subscribers: (() => Promise<{ key: string; value: string }[]>) | undefined;

  constructor(options: DbInboxRegistryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get #value(): string {
    return JSON.stringify({ instanceId: this.#options.instanceId });
  }

  /** Write `keys`, live for a TTL from now. Best-effort: a failure is reported, never thrown. */
  #put(keys: string[]): Promise<void> {
    const expiresAt = this.#now() + this.#options.ttlMs;
    const write = (async () => {
      for (const key of keys) await this.#options.store().put(key, this.#value, expiresAt);
    })().catch((err) => this.#options.onError(err));
    this.#writes.add(write);
    void write.finally(() => this.#writes.delete(write));
    return write;
  }

  #keys(): string[] {
    const prefix = this.#options.prefix();
    const id = this.#options.instanceId;
    return [
      ...(this.#inboxActive ? [inboxKey(prefix, id)] : []),
      ...[...this.#tenants].map((t) => tenantSubscriberKey(prefix, t, id)),
    ];
  }

  #ensureRefresh(): void {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setInterval(
      () => void this.#put(this.#keys()),
      Math.max(Math.floor(this.#options.ttlMs / 3), 1),
    );
    this.#refreshTimer.unref?.();
  }

  /** Mark this instance as consuming its addressed rows: its inbox key is written now and kept fresh.
   *  Resolves once the first write landed (or failed). */
  activateInbox(): Promise<void> {
    if (this.#inboxActive) return Promise.resolve();
    this.#inboxActive = true;
    this.#ensureRefresh();
    return this.#put([inboxKey(this.#options.prefix(), this.#options.instanceId)]);
  }

  /** Subscribe to `tenant`'s events (idempotent). Resolves once the keys are written. */
  subscribe(tenant: string): Promise<void> {
    if (this.#tenants.has(tenant)) return Promise.resolve();
    this.#tenants.add(tenant);
    this.#inboxActive = true;
    this.#ensureRefresh();
    return this.#put(this.#keys());
  }

  /** End the subscription to `tenant` (its last handler went away): its key is removed. */
  unsubscribe(tenant: string): void {
    if (!this.#tenants.delete(tenant)) return;
    const key = tenantSubscriberKey(this.#options.prefix(), tenant, this.#options.instanceId);
    void Promise.allSettled([...this.#writes])
      .then(() => this.#options.store().remove([key]))
      .catch((err) => this.#options.onError(err));
  }

  /** The instance ids with a live subscription to `tenant` (deduplicated; malformed values skipped). */
  async subscribersOf(tenant: string): Promise<string[]> {
    this.#subscribers ??= cachedLiveKeys(
      this.#options.store(),
      this.#options.subscribersCacheMs,
      this.#now,
    );
    const marker = tenantSubscriberKeyPrefix(this.#options.prefix(), tenant);
    const owners = new Set<string>();
    for (const { key, value } of await this.#subscribers()) {
      if (!key.startsWith(marker)) continue;
      const owner = ownerOf(value);
      if (owner !== undefined) owners.add(owner);
    }
    return [...owners];
  }

  /** The instance ids with a live inbox key — read fresh, never cached (the janitor decides on it). */
  async liveInboxOwners(): Promise<Set<string>> {
    const marker = inboxKey(this.#options.prefix(), '');
    const alive = new Set<string>();
    for (const { key, value } of await this.#options.store().live(this.#now())) {
      if (!key.startsWith(marker)) continue;
      const owner = ownerOf(value);
      if (owner !== undefined) alive.add(owner);
    }
    return alive;
  }

  /** Stop refreshing and remove every key this instance wrote (a clean shutdown). */
  async close(): Promise<void> {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
    const keys = this.#keys();
    this.#tenants.clear();
    this.#inboxActive = false;
    if (keys.length === 0) return;
    await Promise.allSettled([...this.#writes]);
    await Promise.resolve()
      .then(() => this.#options.store().remove(keys))
      .catch((err) => this.#options.onError(err));
  }
}

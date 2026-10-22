import type { DescriptorRedis } from '../worker-runtime/registry.js';
import { cachedLiveKeys, NO_WORKER_KEYS, type WorkerKeyStore } from './worker-keys.js';

/**
 * Naming and bookkeeping for the parts of the store-less (P4) protocol that BullMQ carries on Redis
 * PUB/SUB and that a point-to-point `@adonisjs/queue` adapter cannot broadcast: run replies and tenant
 * events. {@link import('./queue.js').QueueTransport} delivers both through per-instance INBOX queues:
 *
 * - **Run replies** — every requesting instance consumes its own `${P}:run-replies:<instance>`. The
 *   requester stamps its instance id (`replyTo`) on the run-request / start-run job it pushes; the
 *   control-plane instance that pops the job remembers `correlationId → replyTo` while the handler runs,
 *   so the responder's `publishRunReply` lands on exactly the requester's inbox. Nothing is broadcast.
 * - **Tenant events** — every instance subscribed to a tenant sends an {@link InboxRegistration} onto
 *   `${P}:inbox-registrations` when it subscribes and every third of the TTL after that. Whichever
 *   control-plane instance pops it records a TTL'd `${P}-tenant-subscriber:<tenant>:<instance>` key in
 *   the CONTROL PLANE's {@link WorkerKeyStore} (the one its worker descriptors live in, shared by its
 *   replicas). A publisher reads the live subscribers of the event's tenant from that store and pushes
 *   one copy onto each one's `${P}:tenant-events:<instance>` inbox. The subscriber itself needs no store,
 *   which is what lets a store-less tenant pod live-tail.
 *
 * The same registration keeps a TTL'd `${P}-inbox:<instance>` liveness key for every instance that
 * consumes an inbox, which the publisher-side janitor uses to drain the inbox of an instance that died
 * (see {@link InboxRegistry}).
 *
 * A worker with no key store of its own (a store-less tenant pod) advertises its descriptor and
 * heartbeat keys the same way: as {@link KeyAdvertisement}s the control plane records — restricted to
 * the `-worker-descriptor:` / `-worker-heartbeat:` keyspace — so the control plane still sees it.
 *
 * Segments taken from the wire or from user config (tenant, instance id) are URI-encoded inside KEYS, so
 * neither can contain the `:` separator and one tenant's key prefix can never match another's.
 */

/** Default TTL (ms) of the subscriber and inbox liveness keys; re-announced every third of it. */
export const DEFAULT_INBOX_TTL_MS = 30_000;
/** Default reuse window (ms) of the publisher's read of the live tenant subscribers. Short on purpose:
 *  a subscriber that just registered misses the events published inside this window. */
export const DEFAULT_TENANT_SUBSCRIBERS_CACHE_MS = 1_000;
/** Default cadence (ms) of the janitor that drains the inboxes of dead instances. */
export const DEFAULT_INBOX_SWEEP_INTERVAL_MS = 30_000;
/** How many jobs one janitor round pops from one dead inbox (the next round continues). */
const DRAIN_PER_SWEEP = 1_000;
/** Bounds on what a registration read off the wire may ask for. */
const MAX_REGISTRATION_TTL_MS = 10 * 60_000;
const MAX_REGISTRATION_TENANTS = 1_000;

const enc = (segment: string): string => encodeURIComponent(segment);

/** `${P}:run-replies:<instance>` — the inbox a requesting instance consumes its {@link RunReply}s from. */
export function runRepliesQueue(prefix: string, instanceId: string): string {
  return `${prefix}:run-replies:${instanceId}`;
}

/** `${P}:tenant-events:<instance>` — the inbox a subscribing instance consumes its tenant events from. */
export function tenantEventsQueue(prefix: string, instanceId: string): string {
  return `${prefix}:tenant-events:${instanceId}`;
}

/** `${P}:inbox-registrations` — where instances announce their inboxes and subscriptions. */
export function inboxRegistrationsQueue(prefix: string): string {
  return `${prefix}:inbox-registrations`;
}

/** The key prefix of every live subscriber of `tenant`. */
export function tenantSubscriberKeyPrefix(prefix: string, tenant: string): string {
  return `${prefix}-tenant-subscriber:${enc(tenant)}:`;
}

/** `${P}-tenant-subscriber:<tenant>:<instance>` — "this instance wants `tenant`'s events". */
export function tenantSubscriberKey(prefix: string, tenant: string, instanceId: string): string {
  return `${tenantSubscriberKeyPrefix(prefix, tenant)}${enc(instanceId)}`;
}

/** `${P}-inbox:<instance>` — "this instance is alive and consuming its inboxes". */
export function inboxKey(prefix: string, instanceId: string): string {
  return `${prefix}-inbox:${enc(instanceId)}`;
}

/**
 * What an instance announces on `${P}:inbox-registrations`: its inbox liveness and the tenants it wants
 * events for, live for `ttlMs` from when a control plane records it. A subscription that ended is listed
 * in `withdraw`; `inbox: false` withdraws the liveness key (a clean shutdown).
 */
export interface InboxRegistration {
  instanceId: string;
  ttlMs: number;
  inbox: boolean;
  tenants: string[];
  withdraw?: string[] | undefined;
}

/**
 * A worker's descriptor / heartbeat key writes, forwarded to the control plane by an instance with no
 * key store of its own. Only `${P}-worker-descriptor:` and `${P}-worker-heartbeat:` keys are recorded.
 */
export interface KeyAdvertisement {
  kind: 'advertise';
  put: { key: string; value: string; ttlMs: number }[];
  remove: string[];
}

/** Everything sent on `${P}:inbox-registrations`. */
export type RegistryMessage = InboxRegistration | KeyAdvertisement;

/** The value stored under a subscriber / inbox key: the owner's instance id, read back verbatim. */
interface InboxKeyValue {
  instanceId: string;
}

function ownerOf(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<InboxKeyValue>;
    return typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined;
  } catch {
    return undefined;
  }
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= MAX_REGISTRATION_TENANTS && v.every((t) => typeof t === 'string');

/** Narrow a key advertisement read off the wire; anything malformed is `undefined` (ignored). */
export function parseAdvertisement(raw: unknown): KeyAdvertisement | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'advertise' || !Array.isArray(r.put) || !isStringArray(r.remove)) return undefined;
  if (r.put.length > MAX_REGISTRATION_TENANTS) return undefined;
  const put: KeyAdvertisement['put'] = [];
  for (const entry of r.put as unknown[]) {
    const e = entry as Record<string, unknown> | null;
    if (
      !e ||
      typeof e.key !== 'string' ||
      typeof e.value !== 'string' ||
      typeof e.ttlMs !== 'number' ||
      !Number.isFinite(e.ttlMs) ||
      e.ttlMs <= 0
    ) {
      return undefined;
    }
    put.push({ key: e.key, value: e.value, ttlMs: Math.min(e.ttlMs, MAX_REGISTRATION_TTL_MS) });
  }
  return { kind: 'advertise', put, remove: r.remove };
}

/** Narrow a registration read off the wire; anything malformed is `undefined` (ignored). */
export function parseRegistration(raw: unknown): InboxRegistration | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.instanceId !== 'string' || r.instanceId === '') return undefined;
  if (typeof r.ttlMs !== 'number' || !Number.isFinite(r.ttlMs) || r.ttlMs <= 0) return undefined;
  if (typeof r.inbox !== 'boolean' || !isStringArray(r.tenants)) return undefined;
  if (r.withdraw !== undefined && !isStringArray(r.withdraw)) return undefined;
  return {
    instanceId: r.instanceId,
    ttlMs: Math.min(r.ttlMs, MAX_REGISTRATION_TTL_MS),
    inbox: r.inbox,
    tenants: r.tenants,
    withdraw: r.withdraw,
  };
}

export interface InboxRegistryOptions {
  store: WorkerKeyStore;
  /** The effective prefix, read on every use (the namespace can be adopted after construction). */
  prefix: () => string;
  instanceId: string;
  ttlMs: number;
  subscribersCacheMs: number;
  sweepIntervalMs: number;
  /** Send a message onto `${P}:inbox-registrations`. */
  announce: (message: RegistryMessage) => Promise<void>;
  /** Pop and finalize up to `max` jobs of `queue`; resolves `true` once the queue came back empty. */
  drain: (queue: string, max: number) => Promise<boolean>;
  onError: (err: unknown) => void;
  now?: () => number;
}

/**
 * The registry side of the inbox design, in three parts:
 *
 * - **subscriber** — what this instance announces (its subscriptions and its inbox liveness), re-sent
 *   every third of the TTL while it lasts;
 * - **recorder** (control plane) — turns announcements into TTL'd keys in its worker-key store;
 * - **publisher** (control plane) — reads a tenant's live subscribers, and runs the janitor that drains
 *   inboxes it pushed to whose owner stopped announcing itself.
 *
 * Dead instances: a subscriber that dies stops announcing, so within the TTL its keys expire and
 * publishers stop pushing to it — its inbox stops growing. What was pushed meanwhile is drained by the
 * janitor of each publisher that pushed it (tracked in memory): once the owner's `-inbox:` key is gone
 * and the last push is older than the TTL, the publisher pops and completes what is left. A publisher
 * that restarts forgets what it tracked, so a crash of BOTH sides can leave at most a TTL's worth of
 * jobs behind.
 *
 * Without a real key store on the control plane ({@link NO_WORKER_KEYS}) nothing can be recorded or
 * read: tenant events reach no one, and the janitor stays off (it could not tell a live inbox from a
 * dead one).
 */
export class InboxRegistry {
  readonly #options: InboxRegistryOptions;
  readonly #now: () => number;
  readonly #enabled: boolean;
  readonly #subscribers: () => Promise<{ key: string; value: string }[]>;
  /** Tenants this instance currently subscribes to. */
  readonly #tenants = new Set<string>();
  /** Whether this instance consumes an inbox (so it keeps announcing its liveness). */
  #inboxActive = false;
  #refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** Inboxes this instance pushed to: queue → its owner and the time of the last push. */
  readonly #pushed = new Map<string, { owner: string; lastPushAt: number }>();
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  #sweeping: Promise<void> | undefined;
  #warned = false;

  constructor(options: InboxRegistryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#enabled = options.store !== NO_WORKER_KEYS;
    this.#subscribers = cachedLiveKeys(options.store, options.subscribersCacheMs, this.#now);
  }

  // ---------------------------------------------------------------------------
  // subscriber
  // ---------------------------------------------------------------------------

  #announce(withdraw?: string[]): void {
    void this.#options
      .announce({
        instanceId: this.#options.instanceId,
        ttlMs: this.#options.ttlMs,
        inbox: this.#inboxActive,
        tenants: [...this.#tenants],
        ...(withdraw ? { withdraw } : {}),
      })
      .catch((err) => this.#options.onError(err));
  }

  /** Mark this instance as an inbox consumer (announced now and on every refresh). */
  activateInbox(): void {
    if (this.#inboxActive) return;
    this.#inboxActive = true;
    this.#announce();
    this.#ensureRefresh();
  }

  /** Subscribe to `tenant`'s events (idempotent). */
  subscribe(tenant: string): void {
    if (this.#tenants.has(tenant)) return;
    this.#tenants.add(tenant);
    this.#inboxActive = true;
    this.#announce();
    this.#ensureRefresh();
  }

  /** End the subscription to `tenant` (its last handler went away). */
  unsubscribe(tenant: string): void {
    if (!this.#tenants.delete(tenant)) return;
    this.#announce([tenant]);
  }

  #ensureRefresh(): void {
    if (this.#refreshTimer) return;
    this.#refreshTimer = setInterval(
      () => this.#announce(),
      Math.max(Math.floor(this.#options.ttlMs / 3), 1),
    );
    this.#refreshTimer.unref?.();
  }

  /**
   * A {@link DescriptorRedis} that forwards a worker's descriptor / heartbeat writes to the control
   * plane instead of a local store. Writes made in the same tick go out as ONE message (a worker beats
   * every token at once). A failed send is reported, never thrown into the worker's heartbeat.
   */
  remoteKeyWriter(): DescriptorRedis {
    let batch: KeyAdvertisement | undefined;
    const enqueue = (mutate: (b: KeyAdvertisement) => void): Promise<void> => {
      if (!batch) {
        const pending: KeyAdvertisement = { kind: 'advertise', put: [], remove: [] };
        batch = pending;
        mutate(pending);
        return Promise.resolve().then(() => {
          batch = undefined;
          return this.#options.announce(pending).catch((err) => this.#options.onError(err));
        });
      }
      mutate(batch);
      return Promise.resolve();
    };
    return {
      set: (key, value, _mode, ttlSeconds) =>
        enqueue((b) => b.put.push({ key, value, ttlMs: ttlSeconds * 1000 })),
      del: (...keys) => enqueue((b) => b.remove.push(...keys)),
    };
  }

  // ---------------------------------------------------------------------------
  // recorder (control plane)
  // ---------------------------------------------------------------------------

  /** Record a message read off `${P}:inbox-registrations` as TTL'd keys in the store. */
  async record(raw: unknown): Promise<void> {
    const advertisement = parseAdvertisement(raw);
    if (advertisement) return this.#recordAdvertisement(advertisement);
    const registration = parseRegistration(raw);
    if (!registration) return; // malformed: nothing safe to record
    if (!this.#enabled) {
      if (!this.#warned) {
        this.#warned = true;
        this.#options.onError(
          new Error(
            '[QueueTransport] received a tenant-event subscription but has no worker-key store to ' +
              'record it in (transports.queue() defaults to the app database); tenant events cannot ' +
              'reach any subscriber.',
          ),
        );
      }
      return;
    }
    const prefix = this.#options.prefix();
    const { instanceId, ttlMs } = registration;
    const value = JSON.stringify({ instanceId } satisfies InboxKeyValue);
    const expiresAt = this.#now() + ttlMs;
    const removed = (registration.withdraw ?? []).map((t) =>
      tenantSubscriberKey(prefix, t, instanceId),
    );
    if (!registration.inbox) removed.push(inboxKey(prefix, instanceId));
    if (removed.length > 0) await this.#options.store.remove(removed);
    if (registration.inbox)
      await this.#options.store.put(inboxKey(prefix, instanceId), value, expiresAt);
    for (const tenant of registration.tenants) {
      await this.#options.store.put(
        tenantSubscriberKey(prefix, tenant, instanceId),
        value,
        expiresAt,
      );
    }
  }

  /** Record a forwarded worker advertisement — only keys of the worker advertisement keyspace. */
  async #recordAdvertisement(ad: KeyAdvertisement): Promise<void> {
    if (!this.#enabled) return;
    const prefix = this.#options.prefix();
    const allowed = (key: string) =>
      key.startsWith(`${prefix}-worker-descriptor:`) ||
      key.startsWith(`${prefix}-worker-heartbeat:`);
    const removed = ad.remove.filter(allowed);
    if (removed.length > 0) await this.#options.store.remove(removed);
    const now = this.#now();
    for (const { key, value, ttlMs } of ad.put) {
      if (allowed(key)) await this.#options.store.put(key, value, now + ttlMs);
    }
  }

  // ---------------------------------------------------------------------------
  // publisher (control plane)
  // ---------------------------------------------------------------------------

  /** The instance ids with a live subscription to `tenant` (deduplicated; malformed values skipped). */
  async subscribersOf(tenant: string): Promise<string[]> {
    if (!this.#enabled) return [];
    const marker = tenantSubscriberKeyPrefix(this.#options.prefix(), tenant);
    const owners = new Set<string>();
    for (const { key, value } of await this.#subscribers()) {
      if (!key.startsWith(marker)) continue;
      const owner = ownerOf(value);
      if (owner !== undefined) owners.add(owner);
    }
    return [...owners];
  }

  /** Record a push onto `owner`'s inbox `queue`, so the janitor can drain it if `owner` dies. */
  notePush(queue: string, owner: string): void {
    if (!this.#enabled || this.#options.sweepIntervalMs <= 0) return;
    this.#pushed.set(queue, { owner, lastPushAt: this.#now() });
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => {
      if (this.#sweeping) return;
      const round = this.sweep().finally(() => {
        if (this.#sweeping === round) this.#sweeping = undefined;
      });
      this.#sweeping = round;
    }, this.#options.sweepIntervalMs);
    this.#sweepTimer.unref?.();
  }

  /**
   * One janitor round: for every inbox pushed to more than a TTL ago, drain it when its owner no longer
   * has a live `-inbox:` key, or stop tracking it when the owner is alive (it consumed it). Reads the
   * store fresh — never the publisher cache — so a decision to drain is never stale.
   */
  async sweep(): Promise<void> {
    if (this.#pushed.size === 0) return;
    const now = this.#now();
    let live: { key: string; value: string }[];
    try {
      live = await this.#options.store.live(now);
    } catch (err) {
      this.#options.onError(err);
      return;
    }
    const inboxPrefix = inboxKey(this.#options.prefix(), '');
    const alive = new Set<string>();
    for (const { key, value } of live) {
      if (!key.startsWith(inboxPrefix)) continue;
      const owner = ownerOf(value);
      if (owner !== undefined) alive.add(owner);
    }
    for (const [queue, { owner, lastPushAt }] of [...this.#pushed]) {
      if (now - lastPushAt < this.#options.ttlMs) continue;
      if (alive.has(owner)) {
        this.#pushed.delete(queue);
        continue;
      }
      try {
        const emptied = await this.#options.drain(queue, DRAIN_PER_SWEEP);
        // A push that raced the drain re-armed the entry with a newer time: keep tracking it then.
        if (emptied && this.#pushed.get(queue)?.lastPushAt === lastPushAt)
          this.#pushed.delete(queue);
      } catch (err) {
        this.#options.onError(err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  /** Stop the timers and withdraw what this instance announced (best-effort, one last announcement). */
  async close(): Promise<void> {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    await this.#sweeping;
    if (!this.#inboxActive && this.#tenants.size === 0) return;
    const withdraw = [...this.#tenants];
    this.#tenants.clear();
    this.#inboxActive = false;
    await this.#options
      .announce({
        instanceId: this.#options.instanceId,
        ttlMs: this.#options.ttlMs,
        inbox: false,
        tenants: [],
        withdraw,
      })
      .catch((err) => this.#options.onError(err));
  }
}

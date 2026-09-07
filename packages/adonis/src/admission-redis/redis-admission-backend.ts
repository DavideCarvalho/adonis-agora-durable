import { randomUUID } from 'node:crypto';
import type { Admission, AdmissionBackend, AdmissionItem, QueueConfig } from '../index.js';

/**
 * The minimal ioredis surface this backend needs. Both a raw `ioredis` instance and an
 * `@adonisjs/redis` connection satisfy it, so we depend on the surface rather than a concrete type —
 * keeping the peer coupling minimal and the backend testable. `duplicate()` must return a connection
 * usable for pub/sub (only needed when {@link RedisAdmissionBackend.onFreed} is wired).
 */
export interface RedisLike {
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  duplicate(): RedisLike;
  disconnect(): void;
}

export interface RedisAdmissionOptions {
  /** An ioredis instance or `@adonisjs/redis` connection. One connection is reused for every queue. */
  connection: RedisLike;
  /** Key prefix namespacing the admission keys. Defaults to `durable`. */
  prefix?: string;
  /** Stable id for this engine instance ("pod"). Defaults to a random uuid. */
  instanceId?: string;
  /**
   * Liveness TTL (ms) for THIS instance's heartbeat key. A held slot is reclaimed only once its
   * owner's heartbeat lapses — so a live pod keeps its slot no matter how long the step runs, and a
   * crashed pod's slots free within this window. Refreshed on a timer at a third of the TTL. Default 30s.
   */
  instanceTtlMs?: number;
  /**
   * How long a blocked waiter's place is kept after its last `tryAdmit` (ms). A waiter re-registers on
   * every retry, so a still-trying one never expires; one that gave up (run cancelled) is pruned after
   * this, so it can't sit as a phantom best-waiter and deadlock the rest. Defaults to `retryMs * 3`.
   */
  waiterTtlMs?: number;
  /** Delay (ms) a blocked call is told to wait before re-trying admission. Default 1000. */
  retryMs?: number;
  /** Epoch-ms clock; injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
}

// One atomic admit. Reclaims dead-instance slots, prunes stale waiters, enforces the rate window and
// the concurrency cap, then selects the rightful next waiter by (priority desc, fairness round-robin,
// arrival FIFO/LIFO) before taking a slot — all server-side so concurrent pods can't race past the cap.
// Returns {admitted (1|0), retryAt}.
//   KEYS 1 slots(hash slotId→instanceId)  2 waiters(zset waiterId→-priority)  3 wmeta(hash waiterId→"seq|key")
//        4 wexpire(zset waiterId→expiry)   5 keyserved(hash key→tick)          6 rate(string)
//        7 seq(string)                     8 servedSeq(string)
const ACQUIRE_LUA = `
local p=cjson.decode(ARGV[1])
local now=p.now; local instanceId=p.instanceId; local concurrency=p.concurrency
local rateLimit=p.rateLimit; local ratePeriodMs=p.ratePeriodMs; local rateSliding=p.rateSliding or 0; local waiterId=p.waiterId
local priority=p.priority; local retryAt=p.retryAt; local hasOrdering=p.hasOrdering
local fairnessOn=p.fairnessOn; local fairKey=p.fairKey; local instPrefix=p.instPrefix
local waiterTtl=p.waiterTtl; local instTtl=p.instTtl; local lifo=p.lifo

-- refresh own liveness atomically so this pod can never reclaim its own fresh slot
redis.call('SET', instPrefix..instanceId, '1', 'PX', instTtl)

-- reclaim slots whose owning instance is gone; count the live ones
local slotIds=redis.call('HKEYS', KEYS[1]); local inflight=0
for i=1,#slotIds do
  local owner=redis.call('HGET', KEYS[1], slotIds[i])
  if owner and redis.call('EXISTS', instPrefix..owner)==1 then inflight=inflight+1
  else redis.call('HDEL', KEYS[1], slotIds[i]) end
end

-- prune waiters that stopped retrying (cancelled/abandoned)
local stale=redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now)
for i=1,#stale do
  redis.call('ZREM', KEYS[2], stale[i]); redis.call('HDEL', KEYS[3], stale[i]); redis.call('ZREM', KEYS[4], stale[i])
end

if rateLimit>0 then
  if rateSliding==1 then
    -- Rolling window (KEYS[6] is a zset of admission timestamps): prune what aged out, deny until
    -- the OLDEST admission leaves the window (the precise earliest retry instant).
    redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', now-ratePeriodMs)
    local used=redis.call('ZCARD', KEYS[6])
    if used>=rateLimit then
      local oldest=redis.call('ZRANGE', KEYS[6], 0, 0, 'WITHSCORES')
      local ra=retryAt
      if oldest[2] then ra=tonumber(oldest[2])+ratePeriodMs end
      return {0, ra}
    end
  else
    local used=tonumber(redis.call('GET', KEYS[6]) or '0')
    if used>=rateLimit then return {0, retryAt} end
  end
end

local function register()
  if redis.call('ZSCORE', KEYS[2], waiterId)==false then
    local seq=redis.call('INCR', KEYS[7])
    redis.call('HSET', KEYS[3], waiterId, seq..'|'..fairKey)
  end
  redis.call('ZADD', KEYS[2], -priority, waiterId)
  redis.call('ZADD', KEYS[4], now+waiterTtl, waiterId)
end

if concurrency>0 and inflight>=concurrency then
  if hasOrdering==1 then register() end
  return {0, retryAt}
end

if hasOrdering==1 then
  register()
  local firstWS=redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  local topScore=firstWS[2]
  local tier=redis.call('ZRANGEBYSCORE', KEYS[2], topScore, topScore)
  local bestId=nil; local bestServed=nil; local bestSeq=nil
  for i=1,#tier do
    local wid=tier[i]; local meta=redis.call('HGET', KEYS[3], wid)
    if meta then
      local sep=string.find(meta, '|', 1, true)
      local seq=tonumber(string.sub(meta, 1, sep-1))
      local k=string.sub(meta, sep+1)
      local served=0
      if fairnessOn==1 and k~='' then served=tonumber(redis.call('HGET', KEYS[5], k) or '0') end
      local better=false
      if bestId==nil then better=true
      elseif served<bestServed then better=true
      elseif served==bestServed then
        if lifo==1 then better=(seq>bestSeq) else better=(seq<bestSeq) end
      end
      if better then bestId=wid; bestServed=served; bestSeq=seq end
    end
  end
  if bestId~=waiterId then return {0, retryAt} end
end

-- admit
redis.call('HSET', KEYS[1], waiterId, instanceId)
redis.call('ZREM', KEYS[2], waiterId); redis.call('HDEL', KEYS[3], waiterId); redis.call('ZREM', KEYS[4], waiterId)
if fairnessOn==1 and fairKey~='' then
  local tick=redis.call('INCR', KEYS[8]); redis.call('HSET', KEYS[5], fairKey, tick)
end
if rateLimit>0 then
  if rateSliding==1 then
    redis.call('ZADD', KEYS[6], now, waiterId..':'..now)
    redis.call('PEXPIRE', KEYS[6], ratePeriodMs*2)
  else
    redis.call('INCR', KEYS[6]); redis.call('PEXPIRE', KEYS[6], ratePeriodMs)
  end
end
return {1, 0}
`;

/** The single JSON-encoded ARGV the Lua acquire decodes — named fields, no positional coupling. */
interface AcquireParams {
  now: number;
  instanceId: string;
  concurrency: number;
  rateLimit: number;
  ratePeriodMs: number;
  /** 1 = rolling-window algorithm (zset of admission timestamps); 0 = fixed counter window. */
  rateSliding: number;
  waiterId: string;
  priority: number;
  retryAt: number;
  hasOrdering: 0 | 1;
  fairnessOn: 0 | 1;
  fairKey: string;
  instPrefix: string;
  waiterTtl: number;
  instTtl: number;
  lifo: 0 | 1;
}

// ioredis custom commands are defined dynamically, so the method isn't on the static type — the one
// localized cast the `defineCommand` typing story requires. The 8 keys stay positional (Redis needs
// them declared); everything else rides in one JSON `params` arg.
type AcquireFn = (
  slots: string,
  waiters: string,
  wmeta: string,
  wexpire: string,
  keyserved: string,
  rate: string,
  seq: string,
  servedseq: string,
  params: string,
) => Promise<[number, number]>;
type RedisWithAcquire = RedisLike & { admissionAcquire: AcquireFn };

/**
 * An {@link AdmissionBackend} whose state lives in Redis, so `concurrency` / `rateLimit` / priority +
 * fairness ordering are enforced ACROSS every engine replica instead of per-process.
 *
 * - **Concurrency** is a hash of slot→owning-instance; a slot is reclaimed only when its owner's
 *   liveness heartbeat lapses, so a live pod holds its slot for the full step duration (no time-lease
 *   false purge) while a crashed pod's slots free within `instanceTtlMs`.
 * - **Rate limit** is a fixed-window counter, or a rolling window (`algorithm: 'sliding'`) counted
 *   over a zset of admission timestamps — no 2× burst at a window boundary.
 * - **Ordering** registers blocked callers and, when a slot frees, admits the rightful next under
 *   (priority desc → fairness round-robin by `key` → arrival FIFO/LIFO). Abandoned waiters are pruned
 *   so a cancelled run can't sit as a phantom best-waiter.
 *
 * Targets a single (non-cluster) Redis — the atomic Lua spans multiple keys.
 */
export class RedisAdmissionBackend implements AdmissionBackend {
  private readonly redis: RedisWithAcquire;
  private readonly prefix: string;
  private readonly instanceId: string;
  private readonly instanceTtlMs: number;
  private readonly waiterTtlMs: number;
  private readonly retryMs: number;
  private readonly clock: () => number;
  private readonly configs = new Map<string, QueueConfig>();
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private subscriber?: RedisLike;

  constructor(options: RedisAdmissionOptions) {
    this.redis = options.connection as RedisWithAcquire;
    this.prefix = options.prefix ?? 'durable';
    this.instanceId = options.instanceId ?? randomUUID();
    this.instanceTtlMs = options.instanceTtlMs ?? 30_000;
    this.retryMs = options.retryMs ?? 1000;
    this.waiterTtlMs = options.waiterTtlMs ?? this.retryMs * 3;
    this.clock = options.clock ?? Date.now;
    this.redis.defineCommand('admissionAcquire', { numberOfKeys: 8, lua: ACQUIRE_LUA });
    // Keep this instance's liveness fresh even while idle, so slots it holds aren't reclaimed.
    void this.refreshLiveness();
    this.heartbeat = setInterval(
      () => void this.refreshLiveness().catch(() => undefined),
      Math.max(1000, Math.floor(this.instanceTtlMs / 3)),
    );
    this.heartbeat.unref?.();
  }

  register(config: QueueConfig): void {
    this.configs.set(config.name, config);
  }

  handles(queue: string): boolean {
    return this.configs.has(queue);
  }

  async tryAdmit(queue: string, item: AdmissionItem): Promise<Admission> {
    const config = this.configs.get(queue);
    if (!config) return { ok: true }; // unregistered queue → ungated
    const now = this.clock();
    const rate = config.rateLimit;
    const fairnessOn = config.fairness === 'key' ? 1 : 0;
    const lifo = config.order === 'lifo' ? 1 : 0;
    const fairKey = fairnessOn === 1 ? (item.key ?? '') : '';
    // Order-track every call that carries a stable waiterId (the engine always does), so even a plain
    // concurrency queue admits blocked waiters by arrival FIFO — identical to the in-process backend.
    const hasOrdering =
      item.waiterId != null || item.priority != null || fairnessOn === 1 || lifo === 1 ? 1 : 0;
    const rateSliding = rate?.algorithm === 'sliding';
    // Sliding uses ONE zset key (its own name — never colliding with a fixed window's counter
    // buckets, so flipping the algorithm on a live queue can't hit a WRONGTYPE).
    const rateKey = rateSliding
      ? this.key(queue, 'rate-sliding', 0)
      : rate
        ? this.key(queue, 'rate', Math.floor(now / rate.periodMs))
        : this.key(queue, 'rate', 0);
    const params: AcquireParams = {
      now,
      instanceId: this.instanceId,
      concurrency: config.concurrency ?? 0,
      rateLimit: rate?.limit ?? 0,
      ratePeriodMs: rate?.periodMs ?? 0,
      rateSliding: rateSliding ? 1 : 0,
      waiterId: item.waiterId ?? `anon:${now}`,
      priority: item.priority ?? 0,
      retryAt: now + this.retryMs,
      hasOrdering,
      fairnessOn,
      fairKey,
      instPrefix: this.instPrefix(),
      waiterTtl: this.waiterTtlMs,
      instTtl: this.instanceTtlMs,
      lifo,
    };
    const [admitted, retryAt] = await this.redis.admissionAcquire(
      this.key(queue, 'slots'),
      this.key(queue, 'waiters'),
      this.key(queue, 'wmeta'),
      this.key(queue, 'wexpire'),
      this.key(queue, 'keyserved'),
      rateKey,
      this.key(queue, 'seq'),
      this.key(queue, 'servedseq'),
      JSON.stringify(params),
    );
    return admitted === 1 ? { ok: true } : { ok: false, retryAt };
  }

  async release(queue: string, slotId: string): Promise<void> {
    await this.redis.hdel(this.key(queue, 'slots'), slotId);
    // Tell the fleet a slot freed so blocked waiters can re-contend now (best-effort; the retry tick
    // is the guarantee). One channel, queue name as payload.
    await this.redis.publish(this.freedChannel(), queue);
  }

  onFreed(handler: (queue: string) => void): void {
    // A subscriber connection can't run normal commands, so use a dedicated dup of the connection.
    const sub = this.redis.duplicate();
    this.subscriber = sub;
    void sub.subscribe(this.freedChannel());
    sub.on('message', (_channel, queue) => handler(queue));
  }

  /** Stop the liveness heartbeat + subscriber (held slots lapse within `instanceTtlMs`). */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.subscriber?.disconnect();
  }

  private freedChannel(): string {
    return `${this.prefix}:adm:freed`;
  }

  private async refreshLiveness(): Promise<void> {
    await this.redis.set(`${this.instPrefix()}${this.instanceId}`, '1', 'PX', this.instanceTtlMs);
  }

  private instPrefix(): string {
    return `${this.prefix}:adm:inst:`;
  }

  private key(queue: string, part: string, window?: number): string {
    const base = `${this.prefix}:adm:${queue}:${part}`;
    return window === undefined ? base : `${base}:${window}`;
  }
}

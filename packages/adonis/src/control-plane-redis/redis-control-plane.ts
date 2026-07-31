import type { ControlMessage, ControlPlane } from '../index.js';

/**
 * The raw-`ioredis` half of {@link RedisPubSub}. A real `Redis` instance is assignable to this.
 *
 * A subscriber connection can't run normal commands, so the driver `duplicate()`s a dedicated one,
 * calls `subscribe(channel)` on it, and receives payloads via `on('message', (channel, message))`.
 * `subscribe` therefore takes the channel and NOTHING else here: ioredis's real overloads are
 * `(...channels, callback?)` where `callback` is a node-style `(err, result)` completion callback —
 * *not* a per-message handler. Declaring a per-message handler parameter on this arm is what made
 * the old single-interface port unsatisfiable by a real client (see {@link RedisPubSub}).
 *
 * This is the surface of the *subscriber* half specifically — see {@link IoredisPubSub} for the
 * command connection a caller actually passes in.
 */
export interface IoredisSubscriber {
  /** Subscribe to a channel. Payloads arrive on `on('message')`, never through an argument here. */
  subscribe(channel: string): unknown;
  /** A payload on a channel this connection is subscribed to. */
  on?(event: 'message', listener: (channel: string, message: string) => void): unknown;
  /** A connection-level failure — the driver logs one line per reconnect burst. */
  on?(event: 'error', listener: (err: Error) => void): unknown;
  /** The connection (re)established — the driver re-arms its error logging. */
  on?(event: 'ready', listener: () => void): unknown;
  /**
   * Tear down this subscriber connection. `disconnect(true)` reconnects (ioredis's `retryStrategy`
   * + `autoResubscribe`) rather than closing for good.
   */
  disconnect?(reconnect?: boolean): void;
  /** Liveness probe. Legal in subscriber mode (ioredis's `VALID_IN_SUBSCRIBER_MODE`). */
  ping?(): Promise<unknown>;
  /** Connection state — the watchdog skips anything that isn't `'ready'`. */
  status?: string;
}

/**
 * The raw-ioredis **command** connection the caller hands us: a subscriber surface plus the two
 * things only a command connection can do — `publish`, and `duplicate()` to mint the subscriber.
 * `duplicate()` returns an {@link IoredisSubscriber} rather than another `IoredisPubSub` on purpose:
 * a connection in subscriber mode can't run normal commands, so nothing may publish or re-duplicate
 * through it.
 */
export interface IoredisPubSub extends IoredisSubscriber {
  /** Publish a message to a channel (returns a promise; the driver only awaits it). */
  publish(channel: string, message: string): unknown;
  /** Build a dedicated subscriber connection (pub/sub can't share a command client). */
  duplicate(): IoredisSubscriber;
}

/**
 * The `@adonisjs/redis` half of {@link RedisPubSub}. A `RedisConnection` is assignable to this.
 *
 * This client manages its own subscriber connection internally — no `duplicate()` needed — and hands
 * the payload straight to the handler. Its handler is `(data: string) => …`: it receives the message
 * ONLY, never the channel, which is why no channel parameter is declared here.
 *
 * It deliberately declares no `on`/`ping`/`status`/`disconnect`. `RedisConnection#on` is an
 * emittery-style `<Name extends keyof ConnectionEvents>(eventName, listener, options?)`, which is
 * not assignable to a plain `(event: string, listener)` — declaring one here (as the old port did)
 * made a real `@adonisjs/redis` connection unassignable too. The driver never needs it: every
 * `on`/`ping`/`status`/`disconnect` call happens on the *duplicated* subscriber, which only exists
 * on the ioredis path.
 */
export interface AdonisRedisPubSub {
  /** Publish a message to a channel (returns a promise; the driver only awaits it). */
  publish(channel: string, message: string): unknown;
  /** Subscribe to a channel; the handler receives each payload directly. */
  subscribe(channel: string, handler: (message: string) => void): unknown;
}

/**
 * The minimal Redis pub/sub surface this control plane needs: EITHER a raw `ioredis` instance
 * ({@link IoredisPubSub}) OR an `@adonisjs/redis` connection ({@link AdonisRedisPubSub}). We depend
 * on the surface rather than the concrete types so the peer coupling stays optional.
 *
 * It is a union, not one wide interface, because the two clients' `subscribe` signatures are
 * genuinely incompatible and no single signature covers both: ioredis is variadic channels plus an
 * optional **node-style `(err, result)`** callback, while `@adonisjs/redis` is `(channel, handler)`
 * with a per-message handler. A single `subscribe(channel, handler?)` describes only the second, so
 * a real `Redis` was NOT assignable — passing one to `defineConfig` was a compile error, even though
 * the driver's own feature detection assumes callers can. Modelling the two arms separately is the
 * honest fix; {@link isIoredisClient} maps the runtime feature test onto the right arm.
 */
export type RedisPubSub = IoredisPubSub | AdonisRedisPubSub;

/**
 * Which of the two clients are we holding? Detected by feature: a raw ioredis client exposes
 * `duplicate()`, the `@adonisjs/redis` connection does not (it hides its `ioConnection`). That is
 * the same test the driver has always used; expressing it as a type predicate is what lets the two
 * call shapes of `subscribe` be told apart without a cast.
 */
function isIoredisClient(connection: RedisPubSub): connection is IoredisPubSub {
  return 'duplicate' in connection && typeof connection.duplicate === 'function';
}

export interface RedisControlPlaneOptions {
  /** An ioredis instance or an `@adonisjs/redis` connection used for pub/sub. */
  connection: RedisPubSub;
  /**
   * Key prefix namespacing the control channel. Defaults to `durable`. The channel is
   * `` `${prefix}-control` `` — matched EXACTLY to the NestJS BullMQ transport so an AdonisJS fleet
   * and a NestJS fleet sharing one Redis interoperate on the same control plane.
   */
  prefix?: string;
  /**
   * How often (ms) to PING the duplicated pub/sub subscriber connection to detect — and recover
   * from — a silent connection loss. A subscriber connection never WRITEs on its own (it only
   * receives PUBLISHed messages), so when a VPN/NAT/idle-timeout drops the underlying TCP
   * connection, ioredis has nothing that would surface the loss: no write ever fails, no timeout
   * ever fires, and the connection sits "subscribed" forever while the server's `PUBSUB NUMSUB`
   * already shows 0 — cross-pod cancels and lifecycle events silently stop arriving until the
   * process restarts. A PING rejection or timeout means the connection is dead, so we
   * `disconnect(true)` it: ioredis's `retryStrategy` reconnects and `autoResubscribe` (default
   * `true`) restores the channel automatically.
   *
   * Pass `0` or `false` to disable (e.g. a short-lived test where the interval would outlive it).
   * Defaults to `30_000`. Only applies to the raw-ioredis path — an `@adonisjs/redis` connection
   * manages its own subscriber connection and its own health.
   */
  pingIntervalMs?: number | false;
}

/** Default {@link RedisControlPlaneOptions.pingIntervalMs}. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** How long a single watchdog PING may take before its subscriber is presumed dead. */
const SUBSCRIBER_PING_TIMEOUT_MS = 5_000;

/**
 * Normalise `pingIntervalMs`: `undefined` → the default, `0`/`false` → disabled, any other number
 * → itself verbatim (including a caller's smaller interval for short-lived tests).
 */
function normalizePingInterval(value: number | false | undefined): number | false {
  if (value === undefined) return DEFAULT_PING_INTERVAL_MS;
  if (value === false || value === 0) return false;
  return value;
}

/**
 * A {@link ControlPlane} backed by Redis pub/sub: the cross-pod broadcast channel for workflow
 * **lifecycle events** (so a dashboard-only pod can live-tail a run executing on a worker pod) and
 * **cancellation** (so the pod actually running a run learns it was cancelled elsewhere).
 *
 * This is purely out-of-band signalling — it carries NO replay/determinism weight; the engine
 * already dedupes self-broadcasts by `msg.from`, so a publish Redis echoes back to its own subscriber
 * is ignored. Omit a control plane entirely and the engine is local-only (single instance).
 *
 * The channel name (`` `${prefix}-control` ``) and the JSON payload match the NestJS BullMQ
 * transport, so a mixed AdonisJS + NestJS fleet on one Redis fans out across both runtimes.
 */
export class RedisControlPlane implements ControlPlane {
  private readonly connection: RedisPubSub;
  private readonly channel: string;
  /** Only ever set on the raw-ioredis path — it is the `duplicate()`d subscriber connection. */
  private subscriber: IoredisSubscriber | undefined;
  private subscribed = false;
  private readonly pingIntervalMs: number | false;
  private pingWatchdogTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: RedisControlPlaneOptions) {
    this.connection = options.connection;
    this.channel = `${options.prefix ?? 'durable'}-control`;
    this.pingIntervalMs = normalizePingInterval(options.pingIntervalMs);
  }

  async publishControl(msg: ControlMessage): Promise<void> {
    await this.connection.publish(this.channel, JSON.stringify(msg));
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    if (this.subscribed) return; // one subscription per control plane
    this.subscribed = true;

    const deliver = (payload: string) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(payload) as ControlMessage;
      } catch {
        return; // swallow malformed payloads — a control message must never crash the engine
      }
      handler(msg);
    };

    if (isIoredisClient(this.connection)) {
      // raw ioredis: a subscriber connection can't run normal commands → use a dedicated dup.
      const sub = this.connection.duplicate();
      this.subscriber = sub;
      void sub.subscribe(this.channel);
      sub.on?.('message', (_channel, payload) => deliver(payload));
      this.trackSubscriber(sub);
    } else {
      // `@adonisjs/redis` connection: manages its own subscriber connection; handler gets the message.
      void this.connection.subscribe(this.channel, (payload) => deliver(payload));
    }
  }

  /**
   * Attach a de-duplicated `error` listener to the duplicated subscriber and start the ping
   * watchdog. The `error` listener is not optional hygiene: an unhandled `error` event on an
   * ioredis instance crashes the process in some setups, and a dead/reconnecting subscriber emits
   * them in bursts — so this connection, which nothing else listens to, would take the app down.
   */
  private trackSubscriber(sub: IoredisSubscriber): void {
    let loggedSinceReady = false;
    sub.on?.('error', (err) => {
      if (loggedSinceReady) return; // one line per reconnect burst, not one per retry
      loggedSinceReady = true;
      console.warn(`[adonis-durable] control-plane subscriber error: ${err.message}`);
    });
    sub.on?.('ready', () => {
      loggedSinceReady = false;
    });
    this.startPingWatchdog(sub);
  }

  /**
   * Start the watchdog interval, unless it's disabled or already running (idempotent). Unref'd so
   * it never keeps the process alive on its own; cleared in {@link close}.
   */
  private startPingWatchdog(sub: IoredisSubscriber): void {
    if (this.pingWatchdogTimer || this.pingIntervalMs === false) return;
    if (typeof sub.ping !== 'function') return; // not an ioredis-shaped connection — nothing to probe
    this.pingWatchdogTimer = setInterval(() => {
      void this.pingSubscriber(sub);
    }, this.pingIntervalMs);
    this.pingWatchdogTimer.unref?.();
  }

  /**
   * PING the subscriber; on rejection or timeout, `disconnect(true)` so ioredis's `retryStrategy`
   * reconnects and `autoResubscribe` restores the channel. Skips a connection that isn't `'ready'`
   * — it's already mid-(re)connect, so a fresh ping would just race that cycle.
   *
   * The timeout is capped at `pingIntervalMs` itself (never above `SUBSCRIBER_PING_TIMEOUT_MS`):
   * waiting longer than the gap between checks to declare one dead would just mean two checks race
   * each other, and it lets a short interval shrink the whole detect → reconnect cycle instead of
   * always eating the full multi-second default.
   */
  private async pingSubscriber(sub: IoredisSubscriber): Promise<void> {
    if (sub.status !== undefined && sub.status !== 'ready') return;
    const timeoutMs =
      this.pingIntervalMs === false
        ? SUBSCRIBER_PING_TIMEOUT_MS
        : Math.min(SUBSCRIBER_PING_TIMEOUT_MS, this.pingIntervalMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ping timed out')), timeoutMs);
        sub
          .ping?.()
          .then(() => {
            clearTimeout(timer);
            resolve();
          })
          .catch((err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    } catch (err) {
      // A ping in flight when close() lands would otherwise RESURRECT the connection we just tore
      // down: disconnect(true) reconnects rather than closes. Re-check after the await.
      if (this.closed) return;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[adonis-durable] control-plane subscriber unresponsive (${message}) — reconnecting to restore its subscription`,
      );
      sub.disconnect?.(true);
    }
  }

  /** Stop the watchdog and tear down the dedicated subscriber connection (ioredis path). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.pingWatchdogTimer) clearInterval(this.pingWatchdogTimer);
    this.pingWatchdogTimer = undefined;
    this.subscriber?.disconnect?.();
    this.subscriber = undefined;
  }
}

import { randomUUID } from 'node:crypto';
import { decodeConsoleValue, encodeConsoleValue } from '../console-commands.js';
import type {
  ConsoleCommand,
  ConsoleCommandReply,
  ControlMessage,
  ControlPlane,
  ControlPublishTarget,
} from '../index.js';
import { sealerOf, type TransportMessagesOptions } from '../messages/resolve.js';
import { isSealedMessage, type MessageSealer } from '../messages/sealer.js';
import { swallowSubscribe } from '../safe-subscribe.js';
import { controlChannel, effectivePrefix } from '../transports/bullmq/naming.js';
import {
  ConsoleChannelError,
  ConsoleCommandAuth,
  type ConsoleCommandAuthOptions,
  type ConsoleSideOptions,
  type IncomingConsoleMessage,
  type OutgoingConsoleMessage,
  refusedCommand,
  TOKEN_UNAVAILABLE,
  UNAUTHORIZED_CONSOLE,
  unsignedError,
  type WireConsoleCommand,
  type WireConsoleReply,
} from './console-auth.js';

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
  /** Subscribe to a channel pattern. Payloads arrive on `on('pmessage')`. */
  psubscribe?(pattern: string): unknown;
  /** A payload on a channel this connection is subscribed to. */
  on?(event: 'message', listener: (channel: string, message: string) => void): unknown;
  /** A payload on a channel matching a pattern this connection is subscribed to. */
  on?(
    event: 'pmessage',
    listener: (pattern: string, channel: string, message: string) => void,
  ): unknown;
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
  /** Publish a message to a channel (returns a promise of the receiver count). */
  publish(channel: string, message: string): unknown;
  /** `SET key value PX ms NX` — claims a console command for one instance. */
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
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
  /** Publish a message to a channel (returns a promise of the receiver count). */
  publish(channel: string, message: string): unknown;
  /** `SET key value PX ms NX` — claims a console command for one instance. */
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  /** Subscribe to a channel; the handler receives each payload directly. */
  subscribe(channel: string, handler: (message: string) => void): unknown;
  /** Subscribe to a channel pattern; the handler receives the channel and each payload. */
  psubscribe?(pattern: string, handler: (channel: string, message: string) => void): unknown;
  /** Drop `handler` from a channel (the channel itself once no handler is left). */
  unsubscribe?(channel: string, handler?: (message: string) => void): unknown;
  /** Drop `handler` from a pattern (the pattern itself once no handler is left). */
  punsubscribe?(pattern: string, handler?: (channel: string, message: string) => void): unknown;
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

/** `SET key value PX <ttl> NX`: `'OK'` for the one caller that wins the key, `null` for the rest. */
type ConsoleClaim = (key: string, value: string) => Promise<unknown>;

/**
 * The atomic claim a console command needs, from either client: ioredis and `@adonisjs/redis`
 * connections both expose `set` (the latter proxies its ioredis commands), and an `@adonisjs/redis`
 * connection that doesn't still holds the ioredis client as `ioConnection`. `undefined` when neither
 * can — the caller then refuses to answer commands instead of running each on every instance.
 */
function consoleClaim(connection: RedisPubSub): ConsoleClaim | undefined {
  const target =
    typeof connection.set === 'function'
      ? connection
      : (connection as { ioConnection?: Pick<IoredisPubSub, 'set'> }).ioConnection;
  const set = target?.set;
  if (typeof set !== 'function') return undefined;
  return (key, value) => set.call(target, key, value, 'PX', CONSOLE_CLAIM_TTL_MS, 'NX');
}

export interface RedisControlPlaneOptions {
  /** An ioredis instance or an `@adonisjs/redis` connection used for pub/sub. */
  connection: RedisPubSub;
  /**
   * As another app's entry in a federated console: how the console authenticates its commands to
   * that app (see {@link ConsoleSideOptions}). Unused on an app's own control plane.
   */
  console?: ConsoleSideOptions | undefined;
  /**
   * How control messages (engine events, cancels, schedule pauses) are sealed (see "Encrypting
   * messages"): a ready sealer (what `controlPlanes.redis()` builds from the app), or the options.
   * Default: sent plain (`seal: true` seals), sealed ones opened with `process.env.APP_KEY`. The
   * console channel is authenticated on its own and is not affected.
   */
  messages?: MessageSealer | TransportMessagesOptions | undefined;
  /**
   * Key prefix namespacing the control channel. Defaults to `durable`. The channel is
   * `` `${prefix}-control` ``, or `` `${prefix}-${namespace}-control` `` for a set, non-`default`
   * {@link namespace} — the same folding as the BullMQ transport's names, matched EXACTLY to the
   * NestJS BullMQ transport so an AdonisJS fleet and a NestJS fleet sharing one Redis interoperate on
   * the same control plane.
   */
  prefix?: string;
  /**
   * Deployment namespace folded into the channel name this control plane LISTENS on. Unset adopts the
   * engine's namespace (see {@link RedisControlPlane.useNamespace}); an explicit value wins. `default`
   * keeps the bare `` `${prefix}-control` `` channel. It does not pin publishing: a message about a
   * run still goes to the channel of that run's namespace (see {@link RedisControlPlane.publishControl}).
   */
  namespace?: string;
  /**
   * Which namespaces this instance observes. `'own'`: its own channel only. `'all'`: also every
   * namespace's channel (a `<prefix>-*-control` pattern subscription), for a console's live tail.
   * Unset: `'all'` for an engine with no namespace, or once the process mounts the durable dashboard
   * (see {@link RedisControlPlane.observeAll}); `'own'` otherwise. An explicit value wins.
   */
  observe?: 'all' | 'own';
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

/** How long a console command waits for its answer by default. */
export const CONSOLE_COMMAND_TIMEOUT_MS = 15_000;
/** How long the claim on a console command lives (longer than any answer is waited for). */
const CONSOLE_CLAIM_TTL_MS = 120_000;
/** At most this many command ids are remembered for replay detection (oldest dropped first). */
const CONSOLE_RAN_IDS_MAX = 10_000;

/** The `kind`s of a {@link ControlMessage}. */
const CONTROL_KINDS: ReadonlySet<string> = new Set<ControlMessage['kind']>([
  'event',
  'events',
  'cancel',
  'enqueued',
  'schedulePause',
]);

/** `value` with Redis glob metacharacters escaped, so a prefix matches only itself. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, '\\$&');
}

/** Default {@link RedisControlPlaneOptions.pingIntervalMs}. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
/** How long a single watchdog PING may take before its subscriber is presumed dead. */
const SUBSCRIBER_PING_TIMEOUT_MS = 5_000;

/**
 * Normalise `pingIntervalMs`: `undefined` → the default, `0`/`false` → disabled, a positive finite
 * number → itself verbatim (including a caller's smaller interval for short-lived tests), anything
 * else (negative, NaN, Infinity, past the timer range) → the default.
 */
function normalizePingInterval(value: number | false | undefined): number | false {
  if (value === undefined) return DEFAULT_PING_INTERVAL_MS;
  if (value === false || value === 0) return false;
  // setInterval turns a negative, NaN or > 2^31-1 delay into ~1ms: a PING hot loop. Treat those as
  // unset (the default), like a non-positive stepTimeoutMs.
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    return DEFAULT_PING_INTERVAL_MS;
  }
  return value;
}

/** The largest delay `setInterval` honours (a signed 32-bit int); anything above fires at ~1ms. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * A {@link ControlPlane} backed by Redis pub/sub: the cross-pod broadcast channel for workflow
 * **lifecycle events** (so a dashboard-only pod can live-tail a run executing on a worker pod) and
 * **cancellation** (so the pod actually running a run learns it was cancelled elsewhere).
 *
 * This is purely out-of-band signalling — it carries NO replay/determinism weight; the engine
 * already dedupes self-broadcasts by `msg.from`, so a publish Redis echoes back to its own subscriber
 * is ignored. Omit a control plane entirely and the engine is local-only (single instance).
 *
 * The channel name (`` `${effectivePrefix}-control` ``, the namespace folded in as in the BullMQ
 * transport's names) and the JSON payload match the NestJS BullMQ transport, so a mixed AdonisJS +
 * NestJS fleet on one Redis fans out across both runtimes.
 */
export class RedisControlPlane implements ControlPlane {
  private readonly connection: RedisPubSub;
  /** The channel prefix (`durable` by default): what an app's console-command key is bound to. */
  readonly prefix: string;
  /** How a federated console authenticates to the app behind this plane (its entry's options). */
  readonly console: ConsoleSideOptions;
  /** Seals what this control plane publishes and opens what it receives. */
  private readonly messages: MessageSealer;
  private namespace: string | undefined;
  private readonly explicitNamespace: boolean;
  /** Only ever set on the raw-ioredis path — it is the `duplicate()`d subscriber connection. */
  private subscriber: IoredisSubscriber | undefined;
  private subscribed = false;
  /** Set by {@link deferSubscriptions}: `onControl` waits for {@link startSubscriptions}. */
  private deferred = false;
  private deferredControl: ((msg: ControlMessage) => void) | undefined;
  /** What this plane subscribed on an `@adonisjs/redis` connection, to unsubscribe it on close. */
  private readonly adonisChannels = new Map<string, (message: string) => void>();
  private readonly adonisPatterns = new Map<string, (channel: string, message: string) => void>();
  private readonly observe: 'all' | 'own' | undefined;
  /** {@link observeAll} was called (the dashboard is mounted in this process). */
  private observeAllRequested = false;
  /** The pattern subscription is in place (it is added once, possibly after {@link onControl}). */
  private patternSubscribed = false;
  /** Subscribes the namespaces pattern on the connection {@link onControl} set up. */
  private subscribePattern: ((pattern: string) => void) | undefined;
  private readonly pingIntervalMs: number | false;
  private pingWatchdogTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  /** Raw-ioredis path: the handler of each exactly-subscribed channel on the duplicated subscriber. */
  private readonly channelHandlers = new Map<string, (payload: string) => void>();
  /** Console commands this instance sent and still waits on, by id. */
  private readonly pendingCommands = new Map<string, (reply: ConsoleCommandReply) => void>();
  private repliesSubscribed: Promise<void> | undefined;
  private commandsSubscribed = false;
  /** The console side's authentication, built once per `auth` options object (it caches a token). */
  private readonly senderAuth = new WeakMap<ConsoleCommandAuthOptions, ConsoleCommandAuth>();

  constructor(options: RedisControlPlaneOptions) {
    this.connection = options.connection;
    this.prefix = options.prefix ?? 'durable';
    this.console = options.console ?? {};
    this.messages = sealerOf(options.messages, 'control plane');
    this.namespace = options.namespace;
    this.observe = options.observe;
    this.explicitNamespace = options.namespace !== undefined;
    this.pingIntervalMs = normalizePingInterval(options.pingIntervalMs);
  }

  /** The channel this control plane listens on: `` `${effectivePrefix}-control` ``, as the BullMQ
   *  transports name it. */
  get channel(): string {
    return this.channelFor(this.namespace);
  }

  /**
   * The pattern an engine with no namespace (the operator view over every namespace) also listens on:
   * every namespace's channel, `<prefix>-<namespace>-control`. It never matches the bare
   * `<prefix>-control` (the `*` sits between two dashes), so no message arrives twice. `undefined`
   * when this instance observes its own namespace only (see {@link RedisControlPlaneOptions.observe}).
   */
  get namespacesPattern(): string | undefined {
    const all =
      this.observe === 'all' ||
      (this.observe === undefined && (this.namespace === undefined || this.observeAllRequested));
    return all ? `${escapeGlob(this.prefix)}-*-control` : undefined;
  }

  /**
   * Observe every namespace from now on: the process mounts a console (the durable dashboard), whose
   * live tail follows runs of every namespace whatever the engine's own namespace is. Adds the
   * pattern subscription even after {@link onControl} subscribed. A no-op with `observe: 'own'`.
   */
  observeAll(): void {
    if (this.observe === 'own') return;
    this.observeAllRequested = true;
    this.armPattern();
  }

  /** Subscribe the namespaces pattern once, when this instance observes all and has subscribed. */
  private armPattern(): void {
    const pattern = this.namespacesPattern;
    if (pattern === undefined || this.patternSubscribed || !this.subscribePattern) return;
    this.patternSubscribed = true;
    this.subscribePattern(pattern);
  }

  /** The channel of `namespace` (`''`, `default` and unset are all the bare `<prefix>-control`). */
  channelFor(namespace: string | undefined): string {
    return controlChannel(effectivePrefix(this.prefix, namespace || undefined));
  }

  /** The channel console commands for this app go to (see {@link sendConsoleCommand}). */
  get consoleChannel(): string {
    return `${this.prefix}-console`;
  }

  /** The channel the answers to console commands come back on. */
  get consoleReplyChannel(): string {
    return `${this.prefix}-console-reply`;
  }

  /**
   * Adopt the engine's namespace — unless one was passed to the constructor (an explicit one always
   * wins), or the channel is already subscribed. The engine calls it before it subscribes.
   */
  useNamespace(namespace: string): void {
    if (this.explicitNamespace || this.subscribed) return;
    this.namespace = namespace;
  }

  /**
   * Publish `msg`. A message about a run (`target.namespace` known) goes to the channel of that run's
   * namespace, so the instances serving the run hear it whichever namespace the publisher is in: a
   * console with no namespace cancels a run on a namespaced worker in real time. Anything else goes to
   * this control plane's own channel. The payload is the same either way.
   */
  async publishControl(msg: ControlMessage, target?: ControlPublishTarget): Promise<void> {
    const channel =
      target?.namespace !== undefined ? this.channelFor(target.namespace) : this.channel;
    await this.connection.publish(
      channel,
      JSON.stringify(await this.messages.seal('control', msg)),
    );
  }

  /**
   * Hold the control subscription until {@link startSubscriptions}: a console/REPL process (an ace
   * command) publishes, but must not open a subscriber connection nothing would close.
   */
  deferSubscriptions(): void {
    if (!this.subscribed) this.deferred = true;
  }

  /** Open the subscription {@link deferSubscriptions} held (a worker loop starting). */
  startSubscriptions(): void {
    if (!this.deferred) return;
    this.deferred = false;
    const handler = this.deferredControl;
    this.deferredControl = undefined;
    if (handler) this.onControl(handler);
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    if (this.deferred) {
      this.deferredControl = handler;
      return;
    }
    if (this.subscribed) return; // one subscription per control plane
    this.subscribed = true;

    const deliver = (payload: string, fromPattern = false) => {
      let raw: unknown;
      try {
        raw = JSON.parse(payload);
      } catch {
        return; // swallow malformed payloads — a control message must never crash the engine
      }
      // A pattern can match a channel some other publisher named `…-control`: take control messages
      // only, so a stray payload on such a channel never reaches the engine.
      if (
        fromPattern &&
        !isSealedMessage(raw) &&
        !CONTROL_KINDS.has((raw as { kind?: unknown } | null)?.kind as string)
      ) {
        return;
      }
      // A refused message is logged once by the sealer and dropped.
      const plain = this.messages.openPlain<ControlMessage>('control', raw);
      if (plain !== undefined) handler(plain);
      else void this.messages.open<ControlMessage>('control', raw).then(handler, () => undefined);
    };
    if (isIoredisClient(this.connection)) {
      const sub = this.ioredisSubscriber();
      this.subscribeChannel(this.channel, (payload) => deliver(payload));
      this.subscribePattern = (pattern) => {
        if (typeof sub.psubscribe !== 'function') return;
        // ioredis's `autoResubscribe` restores pattern subscriptions on reconnect too.
        swallowSubscribe(sub.psubscribe(pattern), () => this.closed, 'control-plane');
        sub.on?.('pmessage', (_pattern, _channel, payload) => deliver(payload, true));
      };
      this.armPattern();
    } else {
      // `@adonisjs/redis` connection: manages its own subscriber connection; handler gets the message.
      this.subscribeChannel(this.channel, (payload) => deliver(payload));
      const connection = this.connection;
      this.subscribePattern = (pattern) => {
        if (typeof connection.psubscribe !== 'function') return;
        const onPattern = (_channel: string, payload: string) => deliver(payload, true);
        this.adonisPatterns.set(pattern, onPattern);
        swallowSubscribe(
          connection.psubscribe(pattern, onPattern),
          () => this.closed,
          'control-plane',
        );
      };
      this.armPattern();
    }
  }

  /**
   * The raw-ioredis path's dedicated subscriber (a subscriber connection can't run normal commands),
   * made once and shared by every channel this control plane listens on: payloads are routed to the
   * channel's handler.
   */
  private ioredisSubscriber(): IoredisSubscriber {
    if (this.subscriber) return this.subscriber;
    const sub = (this.connection as IoredisPubSub).duplicate();
    this.subscriber = sub;
    sub.on?.('message', (channel, payload) => this.channelHandlers.get(channel)?.(payload));
    this.trackSubscriber(sub);
    return sub;
  }

  /**
   * Subscribe `handler` to exactly `channel`, on either client. Returns once the subscription is in
   * place (or failed: a failure is logged, never thrown).
   */
  private subscribeChannel(channel: string, handler: (payload: string) => void): Promise<void> {
    let result: unknown;
    if (isIoredisClient(this.connection)) {
      const sub = this.ioredisSubscriber();
      this.channelHandlers.set(channel, handler);
      result = sub.subscribe(channel);
    } else {
      this.adonisChannels.set(channel, handler);
      result = this.connection.subscribe(channel, handler);
    }
    swallowSubscribe(result, () => this.closed, 'control-plane');
    const settled = Promise.resolve(result).then(
      () => undefined,
      () => undefined,
    );
    if (isIoredisClient(this.connection)) return settled;
    // The connection keeps its ioredis subscriber on the public `ioSubscriberConnection` field
    // (created by the subscribe above, replaced if it ends). Watch THAT one: it has the same
    // silent-death failure mode as the duplicated subscriber on the ioredis path. Read on every
    // tick, never held, and never disconnected by close(): the connection belongs to the app.
    const adonis = this.connection as { ioSubscriberConnection?: IoredisSubscriber };
    this.startPingWatchdog(() => adonis.ioSubscriberConnection);
    return settled;
  }

  /**
   * Send `command` to the app whose control plane this is (same prefix) and wait for its answer.
   * Every instance of that app that runs console commands hears it; one claims it and answers.
   * Rejects at once when nobody listens on the app's console channel, and after `timeoutMs`
   * (default {@link CONSOLE_COMMAND_TIMEOUT_MS}) when nobody answers.
   *
   * Redis is not a trust boundary, so a command is never sent without `auth` (a shared `secret`, a
   * `token` sealed to the app's `publicKey`, or `crypto`), and an answer that does not authenticate
   * as the app's (someone else on Redis answering first) is ignored.
   */
  async sendConsoleCommand(
    command: ConsoleCommand,
    options: {
      timeoutMs?: number | undefined;
      auth?: ConsoleCommandAuthOptions | undefined;
      /** The app's name for the messages (the console's key for it). Default: the prefix. */
      app?: string | undefined;
    } = {},
  ): Promise<ConsoleCommandReply> {
    // The automatic choice (§13a) picks the authentication for this command; any failure (a
    // timeout, a refusal, an error) drops it, so the next command decides again.
    const chooser = options.auth?.choose ? options.auth : undefined;
    if (!chooser) return this.sendChosen(command, options, undefined);
    try {
      try {
        return await this.sendChosen(command, options, chooser);
      } catch (error) {
        // Token mode, but its token cannot be minted (no grant, authkit down): crypto reaches the
        // app too, so this command (and the next ones, for a while) goes that way instead (§13b).
        const instead =
          error instanceof ConsoleChannelError && error.code === TOKEN_UNAVAILABLE
            ? chooser.tokenUnavailable?.(error.reason ?? error.message)
            : undefined;
        if (!instead) throw error;
        return await this.sendChosen(command, { ...options, auth: instead }, undefined);
      }
    } catch (error) {
      // Any other failure (a timeout: an app that refused the mode drops the command) decides again.
      chooser.rechoose?.();
      throw error;
    }
  }

  private async sendChosen(
    command: ConsoleCommand,
    options: {
      timeoutMs?: number | undefined;
      auth?: ConsoleCommandAuthOptions | undefined;
      app?: string | undefined;
    },
    chooser: ConsoleCommandAuthOptions | undefined,
  ): Promise<ConsoleCommandReply> {
    const chosen = chooser ? await chooser.choose!() : options.auth;
    const auth = chosen ? this.consoleAuthFor(chosen) : undefined;
    if (!auth?.canSend) throw unsignedError(this.prefix);
    let outgoing: OutgoingConsoleMessage;
    try {
      const { verified: _verified, ...fields } = command;
      outgoing = await auth.wrap({ ...fields, args: encodeConsoleValue(command.args) });
    } catch (err) {
      if (err instanceof ConsoleChannelError) throw err;
      throw new Error(
        `could not prepare the console command for the "${this.prefix}" app: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!this.repliesSubscribed) {
      // The answer can come back within a millisecond: the subscription must be in place first.
      this.repliesSubscribed = this.subscribeChannel(this.consoleReplyChannel, (payload) => {
        let reply: WireConsoleReply;
        try {
          reply = JSON.parse(payload) as WireConsoleReply;
        } catch {
          return;
        }
        if (typeof reply?.id !== 'string') return;
        this.pendingCommands.get(reply.id)?.(reply as ConsoleCommandReply);
      });
    }
    await this.repliesSubscribed;
    const timeoutMs = options.timeoutMs ?? CONSOLE_COMMAND_TIMEOUT_MS;
    return new Promise<ConsoleCommandReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(command.id);
        reject(
          new Error(
            `no instance of "${options.app ?? this.prefix}" answered within ${timeoutMs / 1000}s — the app may have refused the command (check its logs, or run \`node ace agora:doctor\` there)`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pendingCommands.set(command.id, (received) => {
        const reply = received as WireConsoleReply;
        // Closing settles every pending command with no MAC: that one is ours, not the wire's.
        const closing = this.closed && !reply.ok && reply.mac === undefined;
        // An answer without this command's MAC is someone else's (or forged): wait for the real one.
        if (!closing && !outgoing.verifyReply(reply)) return;
        clearTimeout(timer);
        this.pendingCommands.delete(command.id);
        if (!reply.ok && reply.error?.code === UNAUTHORIZED_CONSOLE) auth.unauthorized();
        const { mac: _mac, ...rest } = reply;
        resolve(
          rest.ok
            ? { ...rest, data: decodeConsoleValue(rest.data) }
            : (rest as ConsoleCommandReply),
        );
      });
      const sent = Promise.resolve(
        this.connection.publish(this.consoleChannel, JSON.stringify(outgoing.wire)),
      );
      sent.then(
        (receivers) => {
          // Redis answers how many subscribers got it: none means no instance runs console commands.
          if (typeof receivers === 'number' && receivers === 0) {
            clearTimeout(timer);
            this.pendingCommands.delete(command.id);
            reject(
              new Error(
                `no instance of the "${this.prefix}" app listens for console commands (is it up, with \`consoleCommands\` in config/durable.ts?)`,
              ),
            );
          }
        },
        (err: unknown) => {
          clearTimeout(timer);
          this.pendingCommands.delete(command.id);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** The console side's {@link ConsoleCommandAuth} for `options`, made once. */
  private consoleAuthFor(options: ConsoleCommandAuthOptions): ConsoleCommandAuth {
    let auth = this.senderAuth.get(options);
    if (!auth) {
      auth = new ConsoleCommandAuth({ ...options, prefix: this.prefix });
      this.senderAuth.set(options, auth);
    }
    return auth;
  }

  /**
   * Run the console commands other apps' consoles send this app. Every instance subscribes; the one
   * that wins `SET <prefix>-console-claim:<id> NX` runs the command and publishes the answer, so a
   * command runs once however many web and worker processes the app has. Throws when the connection
   * can't run that `SET` — a command is never run without the claim — and when `auth` accepts no
   * command at all (Redis is not a trust boundary: an unauthenticated command never runs).
   */
  onConsoleCommand(
    handler: (command: ConsoleCommand) => Promise<unknown>,
    options: {
      auth?: ConsoleCommandAuthOptions | undefined;
      onError?: ((error: unknown) => void) | undefined;
    } = {},
  ): void {
    if (this.commandsSubscribed) return;
    const auth = options.auth
      ? new ConsoleCommandAuth({ ...options.auth, prefix: this.prefix })
      : undefined;
    if (!auth?.canAnswer) throw unsignedError(this.prefix);
    // Fail closed: without an atomic claim every instance would run every command (a cancel or a
    // retry N times), so refuse to answer at all rather than answer without one.
    const claim = consoleClaim(this.connection);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" control plane's Redis connection cannot run \`SET key value PX ms NX\`, so console commands cannot be claimed by one instance; refusing to answer them (pass an ioredis client or an @adonisjs/redis connection)`,
      );
    }
    this.commandsSubscribed = true;
    const instance = randomUUID();
    // Never crash on a bad message: whatever a message does (garbage, forged, undecryptable, a
    // throwing `onError`), it is reported and dropped, and the channel keeps serving.
    const report = (error: unknown): void => {
      try {
        options.onError?.(error);
      } catch {
        // A failing reporter must not take the process down either.
      }
    };
    this.subscribeChannel(this.consoleChannel, (payload) => {
      try {
        void this.runConsoleCommand(payload, instance, claim, auth, handler).catch(report);
      } catch (error) {
        report(error);
      }
    });
  }

  /** The console commands this instance ran, until their claim expires (bounded). */
  private readonly ranCommands = new Map<string, number>();

  private rememberRun(id: string): void {
    const now = Date.now();
    // Drop the expired ones, then the oldest while over the cap.
    for (const [ran, until] of this.ranCommands) {
      if (until > now && this.ranCommands.size < CONSOLE_RAN_IDS_MAX) break;
      this.ranCommands.delete(ran);
    }
    this.ranCommands.set(id, now + CONSOLE_CLAIM_TTL_MS);
  }

  private ranCommand(id: string): boolean {
    const until = this.ranCommands.get(id);
    return until !== undefined && until > Date.now();
  }

  private async runConsoleCommand(
    payload: string,
    instance: string,
    claim: ConsoleClaim,
    auth: ConsoleCommandAuth,
    handler: (command: ConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw refusedCommand('not JSON');
    }
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) throw refusedCommand('not JSON');
    if (typeof wire.id !== 'string' || wire.id === '') throw refusedCommand('no command id');
    // Throws for a command no configured mode accepts: it never runs, and nobody is answered.
    const incoming: IncomingConsoleMessage = await auth.unwrap(wire);
    // One instance runs (or refuses) it; a replay inside the freshness window reuses the id, and the
    // claim (kept 2 minutes) refuses it.
    const won = await claim(`${this.prefix}-console-claim:${incoming.id}`, instance);
    if (won !== 'OK') {
      // Another instance's claim is the normal case (silent); a command this instance already ran
      // coming back is a replay.
      if (this.ranCommand(incoming.id)) throw refusedCommand('replayed');
      return;
    }
    this.rememberRun(incoming.id);
    // MAC'd in its wire form (a run's `Date` fields become strings, `undefined` vanishes), or the
    // console would compute another MAC and drop a genuine answer.
    const answer = (reply: WireConsoleReply) =>
      this.connection.publish(
        this.consoleReplyChannel,
        JSON.stringify(incoming.signReply(JSON.parse(JSON.stringify(reply)) as WireConsoleReply)),
      );
    if (!incoming.command) {
      await answer({ id: incoming.id, ok: false, error: incoming.error! });
      // Answered (the console drops its token), and logged here.
      if (incoming.error?.code === UNAUTHORIZED_CONSOLE) throw refusedCommand('token refused');
      return;
    }
    const command: WireConsoleCommand = incoming.command;
    let reply: WireConsoleReply;
    try {
      const args = decodeConsoleValue(command.args);
      const data = await handler({
        id: command.id,
        verb: command.verb,
        args: Array.isArray(args) ? args : [],
        ...(typeof command.actor === 'string' ? { actor: command.actor } : {}),
        ...(Array.isArray(command.capabilities)
          ? {
              capabilities: command.capabilities.filter((c): c is string => typeof c === 'string'),
            }
          : {}),
        ...(command.verified ? { verified: command.verified } : {}),
      });
      reply = { id: command.id, ok: true, data: encodeConsoleValue(data) };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof status === 'number' ? { status } : {}),
        },
      };
    }
    await answer(reply);
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
    this.startPingWatchdog(() => sub);
  }

  /**
   * Start the watchdog interval, unless it's disabled or already running (idempotent). Unref'd so
   * it never keeps the process alive on its own; cleared in {@link close}.
   */
  private startPingWatchdog(current: () => IoredisSubscriber | undefined): void {
    if (this.pingWatchdogTimer || this.pingIntervalMs === false) return;
    this.pingWatchdogTimer = setInterval(() => {
      const sub = current();
      // Not created yet, or not an ioredis-shaped connection: nothing to probe this tick.
      if (!sub || typeof sub.ping !== 'function') return;
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
    for (const [id, settle] of this.pendingCommands) {
      settle({ id, ok: false, error: { message: 'control plane closed' } });
    }
    this.pendingCommands.clear();
    if (this.pingWatchdogTimer) clearInterval(this.pingWatchdogTimer);
    this.pingWatchdogTimer = undefined;
    this.subscriber?.disconnect?.();
    this.subscriber = undefined;
    this.releaseAdonisSubscriptions();
  }

  /**
   * `@adonisjs/redis` path: drop every channel and pattern this plane subscribed (its own handlers
   * only), and when that leaves the connection's subscriber with nothing to listen to, close it — or
   * the subscriber connection outlives the app, and an ace command never exits.
   */
  private releaseAdonisSubscriptions(): void {
    if (isIoredisClient(this.connection)) return;
    const connection = this.connection as AdonisRedisPubSub & {
      subscriptions?: Map<string, unknown>;
      psubscriptions?: Map<string, unknown>;
      ioSubscriberConnection?: { status?: string; disconnect?(): void };
    };
    const quiet = (result: unknown) => {
      Promise.resolve(result).catch(() => undefined);
    };
    for (const [channel, handler] of this.adonisChannels) {
      try {
        quiet(connection.unsubscribe?.(channel, handler));
      } catch {
        // A subscriber already gone: nothing to drop.
      }
    }
    for (const [pattern, handler] of this.adonisPatterns) {
      try {
        quiet(connection.punsubscribe?.(pattern, handler));
      } catch {
        // Same.
      }
    }
    const released = this.adonisChannels.size + this.adonisPatterns.size;
    this.adonisChannels.clear();
    this.adonisPatterns.clear();
    if (released === 0) return;
    // Nobody else subscribed on this connection: its subscriber was ours alone, so close it. Only
    // when the connection says (`@adonisjs/redis` keeps its handlers per channel; an unsubscribed
    // handler can leave an empty set behind). A connection that cannot tell is left alone.
    const idle = (map: Map<string, unknown> | undefined): boolean | undefined =>
      map instanceof Map
        ? [...map.values()].every((handlers) => !(handlers instanceof Set) || handlers.size === 0)
        : undefined;
    const channelsIdle = idle(connection.subscriptions);
    const patternsIdle = idle(connection.psubscriptions);
    const sub = connection.ioSubscriberConnection;
    if (channelsIdle === true && patternsIdle === true && sub && sub.status !== 'end') {
      sub.disconnect?.();
    }
  }
}

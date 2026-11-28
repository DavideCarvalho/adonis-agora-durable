import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Sealing of the messages durable puts on a transport (BullMQ, `@adonisjs/queue`, the db transport)
 * and on the control plane: step tasks, results, heartbeats, workflow turns and decisions, live step
 * events, the tenant ↔ control-plane run requests, replies, starts and events, and control broadcasts.
 *
 * A message keeps the fields a broker routes on (run id, step id, handler name, group, attempt, …) in
 * clear, and everything else (input, output, error, progress, history, context, request bodies, …) is
 * encrypted into one `sealed` field:
 *
 * ```
 * { runId, seq, stepId, name, group, attempt, sealed: 'dm1.k.<iv|tag|AES-256-GCM(json)>' }
 * ```
 *
 * The AAD binds the ciphertext to the message kind and its identity fields (run id, seq, step id, …),
 * so a sealed input cannot be moved into another step, run or message kind. The `dm1.` prefix tells a
 * receiver the message is sealed (and how); a message without `sealed` is plain.
 *
 * Modes (one per transport):
 * - **app key** (`k`): AES-256-GCM with a key derived from `APP_KEY` (HKDF-SHA256, purpose
 *   `agora:durable:messages`). For the processes of one app.
 * - **secret** (`s`): an HMAC-SHA256 over the whole message with a key derived from a shared secret.
 *   Authenticated, but readable on the broker.
 * - **crypto** (`c`): an `@adonis-agora/crypto` key (or any KMS with `encrypt`/`decrypt`) seals a
 *   random session key once an hour per partition; messages are encrypted locally with it. For
 *   traffic across apps (tenant ↔ control plane).
 * - **plain**: no sealing (the wire of earlier versions).
 */

/** A secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type MessageSecret = string | { release(): string };

/** The `encrypt`/`decrypt` pair of `@adonis-agora/crypto` (or of your own KMS). */
export interface MessageCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/** Every kind of message durable seals. */
export type MessageKind =
  | 'task'
  | 'workflowTask'
  | 'result'
  | 'heartbeat'
  | 'decision'
  | 'stepEvent'
  | 'startRun'
  | 'runRequest'
  | 'runReply'
  | 'tenantEvent'
  | 'control';

/** How a transport seals its messages. */
export type MessageMode = 'app-key' | 'secret' | 'crypto' | 'tenant-key' | 'plain';

/** Why a received message was refused. */
export type MessageRejection =
  /** Plain, where sealed messages are required (`acceptPlain` is off). */
  | 'unsealed'
  /** Sealed, but this process cannot open it (no key, another mode, or messages off without a key). */
  | 'unopenable'
  /** Sealed with another key, tampered with, or moved into another slot. */
  | 'unauthenticated'
  /** Not a durable message at all. */
  | 'malformed'
  /** The crypto server could not be reached or refused this process. */
  | 'crypto-unavailable';

/** A received message this process refuses. Transports dead-letter it; it is never retried. */
export class MessageRejectedError extends Error {
  readonly code = 'E_DURABLE_MESSAGE_REJECTED';
  readonly retryable = false;
  constructor(
    readonly kind: MessageKind,
    readonly reason: MessageRejection,
    message: string,
  ) {
    super(message);
    this.name = 'MessageRejectedError';
  }
}

export function isMessageRejected(error: unknown): error is MessageRejectedError {
  return (
    error instanceof MessageRejectedError ||
    (error as { code?: unknown } | null)?.code === 'E_DURABLE_MESSAGE_REJECTED'
  );
}

/** Seals outgoing messages and opens incoming ones, for one transport. */
export interface MessageSealer {
  readonly mode: MessageMode;
  /** How the mode reads in the boot line and the doctor (`app key (auto)`, `secret`, …). */
  readonly label: string;
  /** Whether plain messages are accepted (always in plain mode; with `acceptPlain` otherwise). */
  readonly acceptsPlain: boolean;
  /** The sealed form of `msg` (plain mode: `msg` itself). */
  seal<T extends object>(kind: MessageKind, msg: T): Promise<T>;
  /** The message `raw` carries, authenticated; throws {@link MessageRejectedError}. */
  open<T>(kind: MessageKind, raw: unknown): Promise<T>;
  /**
   * `raw` itself, synchronously, when it is a plain message this sealer accepts; `undefined`
   * otherwise (then {@link open} decides). Keeps the plain path free of an extra tick.
   */
  openPlain<T>(kind: MessageKind, raw: unknown): T | undefined;
  /** Tenant side of the control-plane keys: the transport hands its run-request channel over. */
  attach?: ((wire: { dispatchRunRequest(msg: never): Promise<void> }) => void) | undefined;
  /** Tenant side: a run reply that answers this sealer's key request (consumed, not delivered). */
  takeReply?: ((reply: { requestId: string; result: unknown }) => boolean) | undefined;
  /** Control-plane side: grant a verified tenant its key (the `messageKey` run request). */
  issueTenantKey?:
    | ((input: {
        partition: string;
        publicKey: string;
        requestId: string;
      }) => Promise<{ kid: string; epk: string; ct: string }>)
    | undefined;
}

/** The field a sealed message carries its seal in. */
export const SEALED_FIELD = 'sealed';
/** The version prefix of every seal. */
export const SEAL_PREFIX = 'dm1.';
/** The purpose the app-key mode derives its key from `APP_KEY` under. */
export const APP_KEY_MESSAGES_PURPOSE = 'agora:durable:messages';
/** The `@adonis-agora/crypto` key the crypto mode uses unless another is named. */
export const MESSAGES_CRYPTO_KEY = 'durable-messages';

const PACKAGE = '@adonis-agora/durable';
const AAD_TAG = 'agora:durable:messages';

/**
 * Per kind: the identity fields (kept in clear and bound into the AAD, in this order) and the other
 * routing fields kept in clear. Every other field is sealed.
 */
const SPECS: Record<MessageKind, { id: readonly string[]; clear: readonly string[] }> = {
  task: {
    id: ['runId', 'seq', 'stepId', 'name', 'group'],
    clear: ['transport', 'priority', 'lazyPickupBeat', 'attempt', 'replyTo', 'traceparent'],
  },
  workflowTask: {
    id: ['taskId', 'runId', 'workflow', 'group'],
    clear: ['workflowVersion', 'transport', 'traceparent', 'priority', 'attempt'],
  },
  result: { id: ['runId', 'seq', 'stepId', 'status'], clear: ['startedAt'] },
  heartbeat: { id: ['runId', 'seq', 'stepId', 'group'], clear: ['at'] },
  decision: { id: ['taskId', 'runId', 'status'], clear: [] },
  stepEvent: { id: ['runId', 'seq', 'name', 'phase'], clear: ['startedAt', 'finishedAt'] },
  // `tenant` on a start / run request carries the tenant's token: sealed, never in clear.
  startRun: { id: ['workflow', 'runId'], clear: [] },
  runRequest: { id: ['requestId'], clear: [] },
  runReply: { id: ['requestId'], clear: [] },
  tenantEvent: { id: ['tenant'], clear: [] },
  // `kind` sealed too: a process not upgraded yet sees a control message of no known kind and ignores
  // it, instead of acting on one whose run id or event it cannot read.
  control: { id: ['from'], clear: [] },
};

/** The message kinds, for docs and the doctor. */
export const MESSAGE_KINDS = Object.keys(SPECS) as MessageKind[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether `raw` carries a seal (any mode). */
export function isSealedMessage(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const seal = raw[SEALED_FIELD];
  return typeof seal === 'string' && seal.startsWith(SEAL_PREFIX);
}

/** Which kind a task-queue job is (both kinds share a handler's queue): by its clear fields. */
export function taskKindOf(raw: unknown): 'task' | 'workflowTask' {
  if (!isRecord(raw)) return 'task';
  return typeof raw.workflow === 'string' && typeof raw.taskId === 'string'
    ? 'workflowTask'
    : 'task';
}

function release(secret: MessageSecret, what: string): string {
  const raw = typeof secret === 'string' ? secret : secret?.release?.();
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new TypeError(
      what === 'appKey'
        ? `[${PACKAGE}] sealing messages with the app key needs an APP_KEY of at least 16 characters (\`node ace generate:key\`)`
        : `[${PACKAGE}] the messages \`secret\` must be at least 16 characters (generate one with \`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"\`)`,
    );
  }
  return raw;
}

/** The AES-256-GCM key the app-key mode derives from `APP_KEY`. */
export function deriveMessagesKey(appKey: MessageSecret): Buffer {
  return Buffer.from(
    hkdfSync('sha256', release(appKey, 'appKey'), '', APP_KEY_MESSAGES_PURPOSE, 32),
  );
}

/** An own property, even for `__proto__` (a plain assignment would set the prototype instead). */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** JSON with sorted keys, so a MAC survives brokers that reorder keys (Postgres `jsonb`). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value ?? null))));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) define(out, key, sortKeys(value[key]));
  return out;
}

const idValue = (value: unknown): unknown =>
  value === undefined || value === null
    ? null
    : typeof value === 'object'
      ? canonicalJson(value)
      : value;

/** The AAD of a message: its kind and identity fields. */
function aadOf(kind: MessageKind, msg: Record<string, unknown>): string {
  return JSON.stringify([AAD_TAG, 'dm1', kind, ...SPECS[kind].id.map((f) => idValue(msg[f]))]);
}

/** Split `msg` into the clear part and the sealed part. */
function split(
  kind: MessageKind,
  msg: Record<string, unknown>,
): { clear: Record<string, unknown>; hidden: Record<string, unknown> } {
  const spec = SPECS[kind];
  const clear: Record<string, unknown> = {};
  const hidden: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(msg)) {
    if (value === undefined || field === SEALED_FIELD) continue;
    if (spec.id.includes(field) || spec.clear.includes(field)) define(clear, field, value);
    else define(hidden, field, value);
  }
  return { clear, hidden };
}

/** The clear fields of a received sealed message: only the ones its kind keeps in clear. */
function clearOf(kind: MessageKind, raw: Record<string, unknown>): Record<string, unknown> {
  const spec = SPECS[kind];
  const clear: Record<string, unknown> = {};
  for (const field of [...spec.id, ...spec.clear]) {
    if (raw[field] !== undefined) define(clear, field, raw[field]);
  }
  return clear;
}

const b64 = (buf: Buffer | string): string =>
  (typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf).toString('base64url');

function gcmSeal(key: Buffer, aad: string, plaintext: string): string {
  const iv = randomBytes(12);
  const gcm = createCipheriv('aes-256-gcm', key, iv);
  gcm.setAAD(Buffer.from(aad));
  const body = Buffer.concat([gcm.update(plaintext, 'utf8'), gcm.final()]);
  return Buffer.concat([iv, gcm.getAuthTag(), body]).toString('base64url');
}

/** The plaintext of a {@link gcmSeal}, or `null` when it does not authenticate. */
function gcmOpen(key: Buffer, aad: string, wire: string): string | null {
  try {
    const raw = Buffer.from(wire, 'base64url');
    if (raw.length < 29) return null;
    const gcm = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    gcm.setAAD(Buffer.from(aad));
    gcm.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([gcm.update(raw.subarray(28)), gcm.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Shared by every mode: logs a refusal once per kind and reason, then throws it. */
export type RejectionReporter = (error: MessageRejectedError) => void;

/** A reporter that logs each (kind, reason) once per process, as a warning. */
export function onceReporter(
  transport: string,
  warn: (line: string) => void = (line) => console.warn(line),
): RejectionReporter {
  const seen = new Set<string>();
  return (error) => {
    const key = `${error.kind}:${error.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    warn(
      `[${PACKAGE}] ${transport} messages: refused a ${error.kind} message (${error.reason}): ${error.message}. It is dead-lettered, not retried; further ${error.kind} messages refused for this reason are not logged again. Docs: https://davidecarvalho.github.io/agora/docs/durable/transports/encrypting-messages`,
    );
  };
}

interface Ctx {
  acceptPlain: boolean;
  report: RejectionReporter;
  /** Called with each plain message a sealing transport accepts. */
  onPlain?: ((kind: MessageKind) => void) | undefined;
  /** Opens messages sealed in another mode (plain mode with a key at hand). */
  fallback?: MessageSealer | undefined;
}

abstract class BaseSealer implements MessageSealer {
  abstract readonly mode: MessageMode;
  abstract readonly label: string;
  readonly acceptsPlain: boolean;
  protected readonly ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.acceptsPlain = ctx.acceptPlain;
  }

  reject(kind: MessageKind, reason: MessageRejection, message: string): never {
    const error = new MessageRejectedError(kind, reason, message);
    this.ctx.report(error);
    throw error;
  }

  abstract seal<T extends object>(kind: MessageKind, msg: T): Promise<T>;

  openPlain<T>(kind: MessageKind, raw: unknown): T | undefined {
    if (!this.acceptsPlain || !isRecord(raw) || raw[SEALED_FIELD] !== undefined) return undefined;
    if (this.mode !== 'plain') this.ctx.onPlain?.(kind);
    return raw as T;
  }

  async open<T>(kind: MessageKind, raw: unknown): Promise<T> {
    if (!isRecord(raw)) return this.reject(kind, 'malformed', 'not an object');
    const seal = raw[SEALED_FIELD];
    if (seal === undefined) {
      if (this.acceptsPlain) {
        if (this.mode !== 'plain') this.ctx.onPlain?.(kind);
        return raw as T;
      }
      return this.reject(
        kind,
        'unsealed',
        `a plain message reached a transport that requires sealed messages (set \`messages: { acceptPlain: true }\` on this transport during a migration)`,
      );
    }
    if (typeof seal !== 'string' || !seal.startsWith(SEAL_PREFIX)) {
      return this.reject(kind, 'malformed', 'its `sealed` field is not a durable seal');
    }
    return this.openSealed<T>(kind, raw, seal.slice(SEAL_PREFIX.length));
  }

  protected abstract openSealed<T>(
    kind: MessageKind,
    raw: Record<string, unknown>,
    seal: string,
  ): Promise<T>;

  /** The mode letter of a seal body (`k.…`), checked against this sealer's. */
  protected modeOf(seal: string): string {
    return seal.slice(0, seal.indexOf('.'));
  }

  protected wrongMode(
    kind: MessageKind,
    raw: Record<string, unknown>,
    seal: string,
  ): Promise<never> {
    const fallback = this.ctx.fallback;
    if (fallback) return fallback.open(kind, raw);
    const letter = this.modeOf(seal);
    const theirs =
      letter === 'k'
        ? 'the app key'
        : letter === 's'
          ? 'a shared secret'
          : letter === 'c'
            ? 'crypto'
            : 'an unknown mode';
    return Promise.reject(
      this.rejectError(
        kind,
        'unopenable',
        `it is sealed with ${theirs}, and this transport uses ${this.label}; every process on a transport must use the same messages mode`,
      ),
    );
  }

  protected rejectError(
    kind: MessageKind,
    reason: MessageRejection,
    message: string,
  ): MessageRejectedError {
    const error = new MessageRejectedError(kind, reason, message);
    this.ctx.report(error);
    return error;
  }
}

/** No sealing. Opens sealed messages only through its fallback (the app key, when there is one). */
class PlainSealer extends BaseSealer {
  readonly mode = 'plain' as const;
  readonly label: string;
  readonly attach?: MessageSealer['attach'];
  readonly takeReply?: MessageSealer['takeReply'];
  readonly issueTenantKey?: MessageSealer['issueTenantKey'];
  constructor(ctx: Ctx, label = 'plain') {
    super({ ...ctx, acceptPlain: true });
    this.label = label;
    // The opener's control-plane key plumbing works while sending plain: tenants still get keys.
    const fallback = ctx.fallback;
    if (fallback?.attach) this.attach = (wire) => fallback.attach?.(wire);
    if (fallback?.takeReply) this.takeReply = (reply) => fallback.takeReply?.(reply) ?? false;
    if (fallback?.issueTenantKey) {
      const issue = fallback.issueTenantKey;
      this.issueTenantKey = (input) => issue(input);
    }
  }
  async seal<T extends object>(_kind: MessageKind, msg: T): Promise<T> {
    return msg;
  }
  protected openSealed<T>(
    kind: MessageKind,
    raw: Record<string, unknown>,
    seal: string,
  ): Promise<T> {
    if (this.ctx.fallback) return this.ctx.fallback.open<T>(kind, raw);
    const letter = this.modeOf(seal);
    return Promise.reject(
      this.rejectError(
        kind,
        'unopenable',
        `it is sealed (${letter === 'k' ? 'app key' : letter === 's' ? 'secret' : letter === 'c' ? 'crypto' : 'unknown mode'}), and messages are off on this transport with no key to open it: turn messages on here too (\`messages: 'auto'\` in config/durable.ts, or the transport's \`messages\` option)`,
      ),
    );
  }
}

/** App-key mode: AES-256-GCM, key from `APP_KEY`. */
class AppKeySealer extends BaseSealer {
  readonly mode = 'app-key' as const;
  readonly label: string;
  readonly #key: Buffer;
  constructor(appKey: MessageSecret, ctx: Ctx, label = 'app key (auto)') {
    super(ctx);
    this.#key = deriveMessagesKey(appKey);
    this.label = label;
  }
  async seal<T extends object>(kind: MessageKind, msg: T): Promise<T> {
    if (isSealedMessage(msg)) return msg;
    const { clear, hidden } = split(kind, msg as Record<string, unknown>);
    const wire = gcmSeal(this.#key, aadOf(kind, clear), JSON.stringify(hidden));
    return { ...clear, [SEALED_FIELD]: `${SEAL_PREFIX}k.${wire}` } as T;
  }
  protected async openSealed<T>(
    kind: MessageKind,
    raw: Record<string, unknown>,
    seal: string,
  ): Promise<T> {
    if (!seal.startsWith('k.')) return this.wrongMode(kind, raw, seal);
    const clear = clearOf(kind, raw);
    const text = gcmOpen(this.#key, aadOf(kind, clear), seal.slice(2));
    if (text === null) {
      return this.reject(
        kind,
        'unauthenticated',
        'it does not open with this app key (another APP_KEY, tampered with, or moved from another run, step or kind). If another app shares this transport directly (no control plane between them), give every process of both the same `messages: { secret }` or `messages: { crypto: { cipher } }`, or connect them through a durable control plane (tenant topology)',
      );
    }
    return mergeOpened<T>(this, kind, clear, text);
  }
}

function mergeOpened<T>(
  sealer: { reject(kind: MessageKind, reason: MessageRejection, message: string): never },
  kind: MessageKind,
  clear: Record<string, unknown>,
  text: string,
): T {
  let hidden: unknown;
  try {
    hidden = JSON.parse(text);
  } catch {
    return sealer.reject(kind, 'malformed', 'its sealed part is not JSON');
  }
  if (!isRecord(hidden))
    return sealer.reject(kind, 'malformed', 'its sealed part is not an object');
  return { ...hidden, ...clear } as T;
}

/** Secret mode: HMAC-SHA256 over the whole message; readable on the broker. */
class SecretSealer extends BaseSealer {
  readonly mode = 'secret' as const;
  readonly label = 'secret';
  readonly #key: Buffer;
  constructor(secret: MessageSecret, ctx: Ctx) {
    super(ctx);
    this.#key = Buffer.from(
      hkdfSync('sha256', release(secret, 'secret'), '', `${APP_KEY_MESSAGES_PURPOSE}:secret`, 32),
    );
  }
  #mac(kind: MessageKind, msg: Record<string, unknown>): string {
    const { [SEALED_FIELD]: _seal, ...rest } = msg;
    return createHmac('sha256', this.#key)
      .update(`${aadOf(kind, rest)}\n${canonicalJson(rest)}`)
      .digest('base64url');
  }
  async seal<T extends object>(kind: MessageKind, msg: T): Promise<T> {
    if (isSealedMessage(msg)) return msg;
    const body = JSON.parse(JSON.stringify(msg)) as Record<string, unknown>;
    return { ...body, [SEALED_FIELD]: `${SEAL_PREFIX}s.${this.#mac(kind, body)}` } as T;
  }
  protected async openSealed<T>(
    kind: MessageKind,
    raw: Record<string, unknown>,
    seal: string,
  ): Promise<T> {
    if (!seal.startsWith('s.')) return this.wrongMode(kind, raw, seal);
    const expected = Buffer.from(this.#mac(kind, raw));
    const actual = Buffer.from(seal.slice(2));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return this.reject(
        kind,
        'unauthenticated',
        'its HMAC does not match (another secret, tampered with, or moved from another run, step or kind)',
      );
    }
    const { [SEALED_FIELD]: _seal, ...rest } = raw;
    return rest as T;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Crypto mode                                                                                 */
/* ------------------------------------------------------------------------------------------- */

/** How long a session key is used before a new one is sealed. */
const SESSION_TTL_MS = 60 * 60_000;
/** Opened session keys older than this are refused (queued jobs may wait a day). */
const SESSION_MAX_AGE_MS = 26 * 60 * 60_000;
const SESSION_CACHE = 256;
/** Unknown session keys opened per minute, at most (each is a call to the crypto server). */
const OPEN_BUDGET_PER_MINUTE = 60;

/** Where the crypto mode gets its cipher, per partition. */
export interface CryptoSealerSource {
  /** The crypto key name. */
  key: string;
  /** How the mode reads in the boot line. */
  label: string;
  /**
   * The cipher for `partition` (`''` for an explicit cipher, the partition name in the automatic
   * tenant ↔ control-plane mode). Rejects when this process may not use that partition.
   */
  cipherFor(partition: string): Promise<MessageCipher>;
  /** The partition a message is sealed for. */
  sealPartition(kind: MessageKind, msg: Record<string, unknown>): string;
  /** Whether this process accepts messages sealed for `partition`. */
  accepts(partition: string): boolean;
  /** Whether a ciphertext is one of the crypto key's. Default `agora:ct1:<key>:`. */
  owns?: ((ciphertext: string) => boolean) | undefined;
  /** Called with each opened message (the control plane remembers which tenant asked what). */
  onOpened?(kind: MessageKind, msg: Record<string, unknown>, partition: string): void;
}

interface Session {
  sealed: string;
  key: Buffer;
  iat: number;
  partition: string;
}

class CryptoSealer extends BaseSealer {
  readonly mode = 'crypto' as const;
  readonly label: string;
  readonly #source: CryptoSealerSource;
  readonly #current = new Map<string, Session>();
  readonly #sealing = new Map<string, Promise<Session>>();
  readonly #opened = new Map<string, Session>();
  readonly #opening = new Map<string, Promise<Session | null | 'unavailable'>>();
  #budget = OPEN_BUDGET_PER_MINUTE;
  #budgetResetAt = 0;

  constructor(source: CryptoSealerSource, ctx: Ctx) {
    super(ctx);
    this.#source = source;
    this.label = source.label;
  }

  #sessionAad(partition: string): string {
    return JSON.stringify([AAD_TAG, 'session', partition]);
  }

  #owns(ciphertext: string): boolean {
    const owns = this.#source.owns;
    if (!owns) return ciphertext.startsWith(`agora:ct1:${this.#source.key}:`);
    try {
      return owns(ciphertext) === true;
    } catch {
      return false;
    }
  }

  #remember(session: Session): void {
    if (this.#opened.size >= SESSION_CACHE) {
      const oldest = this.#opened.keys().next().value;
      if (oldest !== undefined) this.#opened.delete(oldest);
    }
    this.#opened.set(session.sealed, session);
  }

  #session(partition: string): Session | Promise<Session> {
    const current = this.#current.get(partition);
    if (current && Date.now() - current.iat < SESSION_TTL_MS) return current;
    const pending = this.#sealing.get(partition);
    if (pending) return pending;
    const key = randomBytes(32);
    const iat = Date.now();
    const aad = this.#sessionAad(partition);
    const promise = this.#source
      .cipherFor(partition)
      .then((cipher) =>
        cipher.encrypt({
          key: this.#source.key,
          plaintext: JSON.stringify({ v: 1, k: key.toString('base64url'), iat, p: partition }),
          aad,
          context: aad,
        }),
      )
      .then(({ ciphertext }) => {
        if (typeof ciphertext !== 'string' || !this.#owns(ciphertext)) {
          throw new Error(
            `[${PACKAGE}] the messages crypto cipher did not return a "${this.#source.key}" ciphertext`,
          );
        }
        const session = { sealed: ciphertext, key, iat, partition };
        this.#current.set(partition, session);
        this.#remember(session);
        return session;
      })
      .finally(() => this.#sealing.delete(partition));
    this.#sealing.set(partition, promise);
    return promise;
  }

  async seal<T extends object>(kind: MessageKind, msg: T): Promise<T> {
    if (isSealedMessage(msg)) return msg;
    const record = msg as Record<string, unknown>;
    const partition = this.#source.sealPartition(kind, record);
    const session = await this.#session(partition);
    const { clear, hidden } = split(kind, record);
    const aad = `${aadOf(kind, clear)}\n${session.sealed}`;
    const wire = gcmSeal(session.key, aad, JSON.stringify(hidden));
    return {
      ...clear,
      [SEALED_FIELD]: `${SEAL_PREFIX}c.${b64(partition)}.${b64(session.sealed)}.${wire}`,
    } as T;
  }

  /** The session key, `null` when it does not open, `'unavailable'` when the cipher failed. */
  #openSession(
    partition: string,
    sealed: string,
  ): Session | null | 'unavailable' | Promise<Session | null | 'unavailable'> {
    const known = this.#opened.get(sealed);
    if (known) {
      if (known.partition !== partition || Date.now() - known.iat > SESSION_MAX_AGE_MS) return null;
      return known;
    }
    const pending = this.#opening.get(sealed);
    if (pending) return pending;
    const now = Date.now();
    if (now >= this.#budgetResetAt) {
      this.#budget = OPEN_BUDGET_PER_MINUTE;
      this.#budgetResetAt = now + 60_000;
    }
    if (this.#budget <= 0) return 'unavailable';
    this.#budget -= 1;
    const aad = this.#sessionAad(partition);
    const promise = this.#source
      .cipherFor(partition)
      .then((cipher) =>
        cipher.decrypt({ key: this.#source.key, ciphertext: sealed, aad, context: aad }),
      )
      .then(({ plaintext }): Session | null | 'unavailable' => {
        const parsed = JSON.parse(plaintext) as {
          v?: unknown;
          k?: unknown;
          iat?: unknown;
          p?: unknown;
        };
        if (parsed?.v !== 1 || typeof parsed.k !== 'string' || typeof parsed.iat !== 'number') {
          return null;
        }
        if (parsed.p !== partition) return null;
        const key = Buffer.from(parsed.k, 'base64url');
        if (key.length !== 32) return null;
        const session = { sealed, key, iat: parsed.iat, partition };
        this.#remember(session);
        return session;
      })
      // A ciphertext that does not authenticate is refused as such; anything else (the crypto
      // server down, this process refused) is reported as the cipher being unavailable.
      .catch((error: unknown): null | 'unavailable' =>
        /authenticat|tag|invalid|unreadable|malformed|ciphertext|decrypt/i.test(
          error instanceof Error ? error.message : String(error),
        )
          ? null
          : 'unavailable',
      )
      .finally(() => this.#opening.delete(sealed));
    this.#opening.set(sealed, promise);
    return promise;
  }

  protected async openSealed<T>(
    kind: MessageKind,
    raw: Record<string, unknown>,
    seal: string,
  ): Promise<T> {
    if (!seal.startsWith('c.')) return this.wrongMode(kind, raw, seal);
    const parts = seal.slice(2).split('.');
    if (parts.length !== 3) return this.reject(kind, 'malformed', 'its crypto seal is malformed');
    const [p64, s64, wire] = parts as [string, string, string];
    const partition = Buffer.from(p64, 'base64url').toString('utf8');
    const sealed = Buffer.from(s64, 'base64url').toString('utf8');
    if (!this.#source.accepts(partition) || !this.#owns(sealed)) {
      return this.reject(
        kind,
        'unauthenticated',
        `it is sealed for partition "${partition}" with another key, which this process does not accept`,
      );
    }
    const session = await this.#openSession(partition, sealed);
    if (session === 'unavailable') {
      return this.reject(
        kind,
        'crypto-unavailable',
        `the crypto cipher could not open its session key with "${this.#source.key}" (the crypto server down or refusing this process, or too many unknown session keys this minute)`,
      );
    }
    if (!session) {
      return this.reject(
        kind,
        'unauthenticated',
        `its session key does not open with the crypto key "${this.#source.key}" (another key or partition, tampered with, too old, or the crypto server refused this process)`,
      );
    }
    const clear = clearOf(kind, raw);
    const text = gcmOpen(session.key, `${aadOf(kind, clear)}\n${session.sealed}`, wire);
    if (text === null) {
      return this.reject(
        kind,
        'unauthenticated',
        'it does not authenticate (tampered with, or moved from another run, step or kind)',
      );
    }
    const opened = mergeOpened<T>(this, kind, clear, text);
    this.#source.onOpened?.(kind, opened as Record<string, unknown>, partition);
    return opened;
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Control-plane keys (tenant ↔ control plane)                                                 */
/* ------------------------------------------------------------------------------------------- */

/** Where a `tenant-key` sealer gets its keys: the control plane's root, or a tenant's handshake. */
export interface PartitionKeySource {
  label: string;
  /** The partition and key a message is sealed with. */
  sealKey(
    kind: MessageKind,
    msg: Record<string, unknown>,
  ): Promise<{ partition: string; kid: string; key: Buffer }>;
  /** The key of `partition` and `kid`, if this process accepts that partition and has the key. */
  openKey(partition: string, kid: string): Promise<Buffer | undefined>;
  /**
   * A partition this process never holds keys for and is not addressed by (another tenant's run
   * replies, broadcast on BullMQ): dropped quietly instead of reported.
   */
  foreign?(partition: string): boolean;
  /** A message sent and accepted plain whatever the policy (the key request that bootstraps it). */
  bootstrap(kind: MessageKind, raw: Record<string, unknown>): boolean;
  onOpened?(kind: MessageKind, msg: Record<string, unknown>, partition: string): void;
  attach?: MessageSealer['attach'];
  takeReply?: MessageSealer['takeReply'];
  issueTenantKey?: MessageSealer['issueTenantKey'];
}

/** `dm1.t.<partition>.<kid>.<iv | tag | AES-256-GCM>`: a control-plane key, per tenant partition. */
class PartitionKeySealer extends BaseSealer {
  readonly mode = 'tenant-key' as const;
  readonly label: string;
  readonly #source: PartitionKeySource;
  readonly attach?: MessageSealer['attach'];
  readonly takeReply?: MessageSealer['takeReply'];
  readonly issueTenantKey?: MessageSealer['issueTenantKey'];

  constructor(source: PartitionKeySource, ctx: Ctx) {
    super(ctx);
    this.#source = source;
    this.label = source.label;
    if (source.attach) this.attach = (wire) => source.attach?.(wire);
    if (source.takeReply) this.takeReply = (reply) => source.takeReply?.(reply) ?? false;
    if (source.issueTenantKey)
      this.issueTenantKey = (input) =>
        (source.issueTenantKey as NonNullable<MessageSealer['issueTenantKey']>)(input);
  }

  #aad(kind: MessageKind, clear: Record<string, unknown>, partition: string, kid: string): string {
    return `${aadOf(kind, clear)}\n${partition}\n${kid}`;
  }

  async seal<T extends object>(kind: MessageKind, msg: T): Promise<T> {
    const record = msg as Record<string, unknown>;
    if (isSealedMessage(msg) || this.#source.bootstrap(kind, record)) return msg;
    const { partition, kid, key } = await this.#source.sealKey(kind, record);
    const { clear, hidden } = split(kind, record);
    const wire = gcmSeal(key, this.#aad(kind, clear, partition, kid), JSON.stringify(hidden));
    return {
      ...clear,
      [SEALED_FIELD]: `${SEAL_PREFIX}t.${b64(partition)}.${kid}.${wire}`,
    } as T;
  }

  override openPlain<T>(kind: MessageKind, raw: unknown): T | undefined {
    if (isRecord(raw) && raw[SEALED_FIELD] === undefined && this.#source.bootstrap(kind, raw)) {
      return raw as T;
    }
    return super.openPlain<T>(kind, raw);
  }

  override async open<T>(kind: MessageKind, raw: unknown): Promise<T> {
    if (isRecord(raw) && raw[SEALED_FIELD] === undefined && this.#source.bootstrap(kind, raw)) {
      return raw as T;
    }
    return super.open<T>(kind, raw);
  }

  protected async openSealed<T>(
    kind: MessageKind,
    raw: Record<string, unknown>,
    seal: string,
  ): Promise<T> {
    if (!seal.startsWith('t.')) return this.wrongMode(kind, raw, seal);
    const parts = seal.slice(2).split('.');
    if (parts.length !== 3)
      return this.reject(kind, 'malformed', 'its control-plane seal is malformed');
    const [p64, kid, wire] = parts as [string, string, string];
    const partition = Buffer.from(p64, 'base64url').toString('utf8');
    if (this.#source.foreign?.(partition)) {
      throw new MessageRejectedError(kind, 'unauthenticated', `it is for partition "${partition}"`);
    }
    let key: Buffer | undefined;
    try {
      key = await this.#source.openKey(partition, kid);
    } catch (error) {
      return this.reject(
        kind,
        'crypto-unavailable',
        `its key (partition "${partition}", kid ${kid}) could not be obtained: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!key) {
      return this.reject(
        kind,
        'unauthenticated',
        `it is sealed for partition "${partition}" with key ${kid}, which this process does not hold (another tenant's, another control plane's, or a key rotated away)`,
      );
    }
    const clear = clearOf(kind, raw);
    const text = gcmOpen(key, this.#aad(kind, clear, partition, kid), wire);
    if (text === null) {
      return this.reject(
        kind,
        'unauthenticated',
        'it does not authenticate (tampered with, or moved from another run, step, kind or tenant)',
      );
    }
    const opened = mergeOpened<T>(this, kind, clear, text);
    this.#source.onOpened?.(kind, opened as Record<string, unknown>, partition);
    return opened;
  }
}

/** What a sealer is made from (one of the modes). */
export type SealerSpec =
  | { mode: 'plain'; label?: string; fallback?: MessageSealer | undefined }
  | { mode: 'app-key'; appKey: MessageSecret; label?: string }
  | { mode: 'secret'; secret: MessageSecret }
  | { mode: 'crypto'; source: CryptoSealerSource }
  | { mode: 'tenant-key'; source: PartitionKeySource };

/** Build a sealer. `report` is called once per refused message (see {@link onceReporter}). */
export function createMessageSealer(
  spec: SealerSpec,
  options: {
    acceptPlain?: boolean | undefined;
    report?: RejectionReporter | undefined;
    onPlain?: ((kind: MessageKind) => void) | undefined;
  } = {},
): MessageSealer {
  const ctx: Ctx = {
    acceptPlain: options.acceptPlain !== false,
    report: options.report ?? onceReporter('transport'),
    onPlain: options.onPlain,
  };
  switch (spec.mode) {
    case 'plain':
      return new PlainSealer({ ...ctx, fallback: spec.fallback }, spec.label);
    case 'app-key':
      return new AppKeySealer(spec.appKey, ctx, spec.label);
    case 'secret':
      return new SecretSealer(spec.secret, ctx);
    case 'crypto':
      return new CryptoSealer(spec.source, ctx);
    case 'tenant-key':
      return new PartitionKeySealer(spec.source, ctx);
  }
}

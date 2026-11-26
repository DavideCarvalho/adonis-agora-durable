import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * How the federated console's commands are authenticated on the Redis control plane (`<prefix>-console`
 * and `<prefix>-console-reply`). Redis is not a trust boundary: whoever can publish there must not be
 * able to cancel, retry, signal or approve a run, nor forge an answer. A control plane neither sends
 * nor answers console commands without one of three modes:
 *
 * 1. **crypto** (`crypto: { cipher, key? }` on both sides): the whole command, with the console's
 *    token when it has one and a one-off reply secret, is encrypted with an `@adonis-agora/crypto` key
 *    (`console-durable` by default). The console may `encrypt` with it, the app `decrypt`.
 * 2. **token** (console `token` + `publicKey`, app `verifyTenant` + `appKey`): the command and the
 *    token are sealed (X25519) to a key derived from the app's `APP_KEY`, whose public half the
 *    console is given in its own config (never read from Redis). The token says which app the console
 *    may act on and what it may do.
 * 3. **shared secret** (`secret` on both sides): an HMAC over every command and answer.
 *
 * Common to all three: a command older than a minute is refused, the claim key (kept two minutes)
 * refuses a replay, an answer is authenticated (so a forged one is ignored), a refused token answers
 * {@link UNAUTHORIZED_CONSOLE} (and the console drops its cached token), and `verified` is only ever
 * set here, never taken from the wire. This file depends on nothing but `node:crypto`: the crypto
 * cipher is structural, so `@adonis-agora/crypto` stays optional.
 */

/** A refused received command: the uniform log line, with its `reason` (§11b). */
export function refusedCommand(reason: string): ConsoleChannelError {
  return new ConsoleChannelError(
    `[@adonis-agora/durable] console commands: refused a command (${reason})`,
    UNSIGNED_CHANNEL,
    reason,
  );
}

/** A short, non-secret id of a console-command public key, for logs (never the key itself). */
export function consoleKeyId(publicKey: string): string {
  return `key ${createHash('sha256').update(publicKey).digest('hex').slice(0, 8)}`;
}

/** The package these messages name. */
const PACKAGE = '@adonis-agora/durable';
/** This package's part of the derivation labels and AADs. */
const CONSOLE_TOPIC = 'durable';

/** How far a command's `ts` may be from this clock (and so how long a replay could live). */
const MAX_COMMAND_SKEW_MS = 60_000;

/** The app refused the console's token (the console drops its cached token). */
export const UNAUTHORIZED_CONSOLE = 'federated-console-unauthorized';
/**
 * Console side: a required app-call token (token mode) could not be minted. Its own code, so a
 * console that can also reach the app by crypto sends that command by crypto instead (§13a).
 */
export const TOKEN_UNAVAILABLE = 'federated-console-token-unavailable';
/** The control plane has no authentication for console commands, or a command failed it. */
export const UNSIGNED_CHANNEL = 'federated-channel-unsigned';

/** A refused or unauthenticated console command. */
export class ConsoleChannelError extends Error {
  readonly code: string;
  /** Why a received command was refused, as the app's log line says it (`bad signature`, …). */
  readonly reason: string | undefined;
  constructor(message: string, code: string, reason?: string) {
    super(message);
    this.name = 'ConsoleChannelError';
    this.reason = reason;
    this.code = code;
  }
}

/** A secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type ConsoleSecret = string | { release(): string };

/** Who the app verified the console as (token mode): set by the channel, never read from the wire. */
export interface VerifiedConsole {
  /**
   * The app (partition) the console's token is for. An app-call token (`appCall`) is bound to this
   * app by its audience instead: its `partition` is the calling (console) app.
   */
  partition: string;
  /** What the token lets the console do there (`durable:runs:write`, …). */
  capabilities: string[];
  /** An authkit app-call token (audience `urn:agora:app:<this app>`): no partition rule applies. */
  appCall?: boolean | undefined;
  /** The client the token was issued to, when the verifier says (for the audit line). */
  clientId?: string | undefined;
}

/** One command as it crosses Redis, before (or after) authentication. Its `args` are JSON. */
export interface WireConsoleCommand {
  id: string;
  verb: string;
  args: unknown;
  actor?: string | undefined;
  /**
   * What the console's viewer may do (the console's `authorize`, else the full console set). Every
   * command carries them, authenticated like the rest of it; the app refuses a command without them.
   */
  capabilities?: string[] | undefined;
  /** When it was sent (ms since the epoch). */
  ts?: number | undefined;
  /** Shared-secret mode: the HMAC of the fields above. */
  mac?: string | undefined;
  /** Never trusted from the wire: set by {@link ConsoleCommandAuth.unwrap} after a token check. */
  verified?: VerifiedConsole | undefined;
}

/** An answer as it crosses Redis. `mac` authenticates it to the console that sent the command. */
export type WireConsoleReply = (
  | { id: string; ok: true; data: unknown }
  | {
      id: string;
      ok: false;
      error: { message: string; code?: string | undefined; status?: number | undefined };
    }
) & { mac?: string | undefined };

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (`crypto.client`, `serviceCipher`). */
export interface ConsoleCipher {
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

/**
 * A cipher, or a function returning one: `config/durable.ts` is read before `@adonis-agora/crypto` is
 * ready, so `() => crypto.client!` (or `() => serviceCipher(crypto.service, 'app')`) defers it to the
 * first command.
 */
export type ConsoleCipherSource = ConsoleCipher | (() => ConsoleCipher | Promise<ConsoleCipher>);

/** Crypto mode, either side: a cipher (any KMS with `encrypt`/`decrypt`) and its key. */
export interface ConsoleCryptoOptions {
  cipher: ConsoleCipherSource;
  /** The key name. Default `console-durable`. */
  key?: string | undefined;
  /**
   * App side, with `verifyTenant` set: `true` (default) refuses a crypto command without a valid
   * token; `false` accepts one without a token (whoever may encrypt is the console) and verifies a
   * token when the command carries one (its capabilities then narrow the command).
   */
  requireToken?: boolean | undefined;
  /**
   * Whether a ciphertext is this cipher's (so the app knows which mode opens a command). Default: the
   * `@adonis-agora/crypto` format, `agora:ct1:<key>:…`. Set it for another KMS's format.
   */
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** The `@adonis-agora/crypto` key console commands are sealed with, unless another is named. */
export const CONSOLE_CRYPTO_KEY = 'console-durable';

/**
 * Where the console gets the token it sends (token mode): a string, a function (authkit-client's
 * `authkitTenantToken(...)`, whose `reset()` drops a cached token after a `401`), or an object with
 * `get()`.
 */
export type ConsoleTokenSource =
  | string
  | (() => string | Promise<string>)
  | { get(): string | Promise<string>; reset?(): void; invalidate?(): void };

/** Verifies the console's token (token mode): `authkitTenantVerifier(...)`, or any `verifyTenant`. */
export type ConsoleTokenVerifier = (request: {
  token?: string | undefined;
  partition?: string | undefined;
}) => VerifiedToken | null | Promise<VerifiedToken | null>;

/** What a {@link ConsoleTokenVerifier} says about a token it accepts. */
export interface VerifiedToken {
  partition: string;
  capabilities?: string[] | undefined;
  clientId?: string | undefined;
  /** An authkit app-call token (bound to this app by its audience, see {@link VerifiedConsole}). */
  appCall?: boolean | undefined;
}

/**
 * How a federated console authenticates its commands to the app behind a control plane: set on that
 * app's entry, `apps.<key>.controlPlane` (`controlPlanes.redis({ connection, prefix, ... })`) in
 * config/durable_dashboard.ts. Nothing to set with `@adonis-agora/crypto` (and authkit's calls
 * between apps) booted in the console app.
 */
export interface ConsoleSideOptions {
  /**
   * Shared-secret mode: the secret shared with that app (its `consoleCommands.secret`), at least 16
   * characters. Every command and answer carries an HMAC under it. For apps with neither authkit nor
   * `@adonis-agora/crypto`.
   */
  secret?: ConsoleSecret | undefined;
  /**
   * Token mode: this console's token for that app — `authkitTenantToken({ issuer, clientId,
   * clientSecret, resource: 'urn:agora:durable' })` of a service-tenant client whose `partition` is
   * that app, or your own `() => Promise<string>`. Without `crypto`, it needs {@link publicKey}.
   * Nothing to set when `@adonis-agora/authkit-client` with calls between apps is booted here and the
   * token can travel sealed: an app-call token for {@link partition} is sent. `false` turns that off.
   */
  token?: ConsoleTokenSource | false | undefined;
  /**
   * Token mode without `crypto`: that app's console-command public key (`node ace durable:console-key`
   * there, or its boot log). Configured here, never read from Redis.
   */
  publicKey?: string | undefined;
  /**
   * Sealed with `@adonis-agora/crypto` (or any KMS): the cipher this console encrypts with. Nothing
   * to set where crypto is booted in this app: the console seals with the `console-durable` key of
   * {@link partition} on its own. `false` turns that off.
   */
  crypto?: ConsoleCryptoOptions | false | undefined;
  /**
   * That app's crypto partition and authkit app name (the automatic modes). Defaults to the entry's
   * key in `apps`.
   */
  partition?: string | undefined;
}

/** How one side of the channel authenticates console commands. Any combination may be set. */
export interface ConsoleCommandAuthOptions {
  /** Shared-secret mode: the same value on the console and on the app (16+ characters). */
  secret?: ConsoleSecret | undefined;
  /**
   * Sealed with `@adonis-agora/crypto`, both sides: the cipher and the key (`console-durable` by
   * default). The console needs `encrypt` on it, the app `decrypt`.
   */
  crypto?: ConsoleCryptoOptions | undefined;
  /** Console side: the token each command carries (`authkitTenantToken(...)`). */
  token?: ConsoleTokenSource | undefined;
  /**
   * Console side, token mode without `crypto`: the app's console-command public key, as that app
   * prints it (`node ace durable:console-key`). Configured here, or resolved from authkit's key
   * directory (a function, called per command) — never read from Redis.
   */
  publicKey?: ConsolePublicKeySource | undefined;
  /**
   * Console side, crypto mode: send without the token when getting it fails (the token is optional
   * there: it only narrows what the console may do).
   */
  tokenOptional?: boolean | undefined;
  /**
   * Console side: pick the authentication per command (the automatic choice between authkit's key
   * directory and crypto, §13a). `rechoose()` forgets the choice (the app did not answer).
   */
  choose?: (() => Promise<ConsoleCommandAuthOptions>) | undefined;
  rechoose?: (() => void) | undefined;
  /**
   * Console side, with `choose`: the chosen token mode could not mint its token (`reason`). Returns
   * what this command (and the next ones, for a while) goes by instead — crypto — or `undefined`
   * when there is no other way (§13a, §13b).
   */
  tokenUnavailable?: ((reason: string) => ConsoleCommandAuthOptions | undefined) | undefined;
  /** App side, token mode without `crypto`: the `APP_KEY` the command key pair is derived from. */
  appKey?: ConsoleSecret | undefined;
  /** App side: verifies the console's token (`authkitTenantVerifier(...)`). */
  verifyTenant?: ConsoleTokenVerifier | undefined;
}

function release(secret: ConsoleSecret): string {
  return typeof secret === 'string' ? secret : secret.release();
}

/** `value` as JSON with sorted keys (and `undefined` properties dropped): what a MAC is taken over. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sameMac(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fresh(ts: unknown): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= MAX_COMMAND_SKEW_MS;
}

function replyFields(reply: WireConsoleReply): unknown[] {
  return [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
}

function macOf(key: Buffer, kind: 'command' | 'reply', fields: unknown): string {
  return createHmac('sha256', key)
    .update(`${kind}\n${canonicalJson(fields)}`)
    .digest('base64url');
}

/** What one sent command needs from the channel's authentication. */
export interface OutgoingConsoleMessage {
  /** The message to publish. */
  wire: unknown;
  /** Whether an answer is really the app's (a forged one is ignored). */
  verifyReply(reply: WireConsoleReply): boolean;
}

/** A command that arrived, once its authentication is checked. */
export interface IncomingConsoleMessage {
  id: string;
  /** The command to run, or `undefined` when it must be answered with `error`. */
  command?: WireConsoleCommand | undefined;
  error?: { message: string; code: string; status: number } | undefined;
  /** Authenticates the answer to the console that sent it. */
  signReply(reply: WireConsoleReply): WireConsoleReply;
}

interface ChannelMode {
  /** How this mode reads in a refusal (`secret`, `crypto (key console-durable)`, …). */
  label?: string;
  wrap?(command: WireConsoleCommand): Promise<OutgoingConsoleMessage>;
  unwrap?(wire: Record<string, unknown>): Promise<IncomingConsoleMessage | null>;
  unauthorized?(): void;
}

/** Shared-secret mode: both sides hold the same secret and HMAC every command and answer. */
class SecretMode implements ChannelMode {
  readonly label = 'secret';
  readonly #key: Buffer;
  constructor(secret: ConsoleSecret, prefix: string) {
    const raw = release(secret);
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        `[${PACKAGE}] console commands: the shared secret must be at least 16 characters`,
      );
    }
    this.#key = createHmac('sha256', raw)
      .update(`agora:console-commands:${CONSOLE_TOPIC}:${prefix}`)
      .digest();
  }

  #commandFields(command: WireConsoleCommand): unknown[] {
    return [
      command.id,
      command.verb,
      command.args ?? [],
      command.actor ?? null,
      command.capabilities ?? null,
      command.ts ?? null,
    ];
  }

  #signReply = (reply: WireConsoleReply): WireConsoleReply => {
    const { mac: _mac, ...rest } = reply;
    return { ...rest, mac: macOf(this.#key, 'reply', replyFields(rest)) } as WireConsoleReply;
  };

  async wrap(command: WireConsoleCommand): Promise<OutgoingConsoleMessage> {
    const { mac: _mac, verified: _verified, ...fields } = command;
    const stamped = { ...fields, ts: Date.now() };
    return {
      wire: { ...stamped, mac: macOf(this.#key, 'command', this.#commandFields(stamped)) },
      verifyReply: (reply) => sameMac(macOf(this.#key, 'reply', replyFields(reply)), reply.mac),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingConsoleMessage | null> {
    if (typeof wire.mac !== 'string') return null;
    const command = wire as unknown as WireConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return null;
    // Unsigned, stale (over a minute) or tampered: not from the console that holds the secret. A
    // replay inside the window reuses the id, and the claim (kept 2 minutes) refuses it.
    if (!sameMac(macOf(this.#key, 'command', this.#commandFields(command)), command.mac)) {
      throw refusedCommand('bad signature');
    }
    if (!fresh(command.ts)) throw refusedCommand('stale');
    const { mac: _mac, ts: _ts, verified: _verified, ...fields } = command;
    return { id: command.id, command: fields, signReply: this.#signReply };
  }
}

/**
 * How a sealed command is encrypted: to the app's command key derived from its `APP_KEY`, or with a
 * key of `@adonis-agora/crypto`. Either way only the owning app opens it, and the AAD binds it to
 * this channel and this command id.
 */
interface ConsoleSealer {
  /** Whether `sealed` is this sealer's ciphertext (so the app knows which one opens it). */
  owns(sealed: string): boolean;
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** Seals with an `@adonis-agora/crypto` key: whoever may `encrypt` with it sends, the app opens. */
function cryptoSealer(options: ConsoleCryptoOptions): ConsoleSealer {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const source = options.cipher;
  const cipher = async (): Promise<ConsoleCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        `[${PACKAGE}] console commands: \`crypto.cipher\` is not ready (is @adonis-agora/crypto booted?)`,
      );
    }
    return resolved;
  };
  return {
    // `agora:ct1:<key>:<version>:…`: only this key's ciphertext is taken as a crypto command.
    owns: options.owns ?? ((sealed) => sealed.startsWith(`agora:ct1:${key}:`)),
    async seal(plaintext, aad) {
      const { ciphertext } = await (await cipher()).encrypt({ key, plaintext, aad, context: aad });
      return ciphertext;
    },
    async open(sealed, aad) {
      const { plaintext } = await (await cipher()).decrypt({
        key,
        ciphertext: sealed,
        aad,
        context: aad,
      });
      return plaintext;
    },
  };
}

/** The ciphertext prefix of a command sealed to the app's X25519 command key. */
const APP_KEY_SEAL = 'durable:pk1:';
/** PKCS#8 DER header of a raw 32-byte X25519 private key. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** The app's console-command key pair (token mode), derived from its `APP_KEY` and `prefix`. */
export interface ConsoleCommandKeys {
  /** The public half, base64url (32 bytes): what the console is configured with. */
  publicKey: string;
  privateKey: KeyObject;
}

/**
 * The X25519 key pair console commands are sealed to in token mode, derived from the app's
 * `APP_KEY` and its control plane's `prefix`: the same on every instance of the app, and changed by a
 * new `APP_KEY`. Only the public half ever leaves the app.
 */
export function consoleCommandKeys(appKey: ConsoleSecret, prefix: string): ConsoleCommandKeys {
  const raw = release(appKey);
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new Error(`[${PACKAGE}] console commands: the APP_KEY must be at least 16 characters`);
  }
  const seed = Buffer.from(
    hkdfSync(
      'sha256',
      raw,
      Buffer.from(`${CONSOLE_TOPIC}:console-commands:${prefix}`, 'utf8'),
      Buffer.from('agora:okp:v1:x25519', 'utf8'),
      32,
    ),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  seed.fill(0);
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string };
  return { publicKey: x, privateKey };
}

/** The public half of {@link consoleCommandKeys}: what `node ace durable:console-key` prints. */
export function consoleCommandPublicKey(appKey: ConsoleSecret, prefix: string): string {
  return consoleCommandKeys(appKey, prefix).publicKey;
}

function x25519Public(x: string): KeyObject {
  if (typeof x !== 'string' || Buffer.from(x, 'base64url').length !== 32) {
    throw new Error(
      `[${PACKAGE}] console commands: \`publicKey\` is not a console-command key (print the app's with \`node ace durable:console-key\`)`,
    );
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
}

function sealKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.concat([ephemeral, recipient]),
      Buffer.from(`agora:${CONSOLE_TOPIC}:console-seal:v1`, 'utf8'),
      32,
    ),
  );
}

/**
 * The app's console-command public key: configured, or looked up (authkit's key directory) — a
 * function resolving to the key, or `null` when there is none to seal to.
 */
export type ConsolePublicKeySource = string | (() => Promise<string | null | undefined>);

/** Seals to the app's X25519 command key (the console side): ECDH with a one-off key, AES-256-GCM. */
function appKeySealerTo(source: ConsolePublicKeySource): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith(APP_KEY_SEAL),
    async seal(plaintext, aad) {
      const publicKey = typeof source === 'string' ? source : await source();
      if (typeof publicKey !== 'string' || publicKey === '') {
        throw new ConsoleChannelError(
          `[${PACKAGE}] no console-command public key to seal to: the app publishes it to authkit's key directory automatically when it has authkit's \`service\` configured and \`consoleCommands\` in token mode; or set the console entry's \`controlPlane.publicKey\` from \`node ace durable:console-key\` on that app`,
          UNSIGNED_CHANNEL,
        );
      }
      const recipient = x25519Public(publicKey);
      const ephemeral = generateKeyPairSync('x25519');
      const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
      const epk = Buffer.from(
        (ephemeral.publicKey.export({ format: 'jwk' }) as { x: string }).x,
        'base64url',
      );
      const key = sealKey(shared, epk, Buffer.from(publicKey, 'base64url'));
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${APP_KEY_SEAL}${Buffer.concat([epk, iv, cipher.getAuthTag(), body]).toString('base64url')}`;
    },
    open: async () => {
      throw new Error('the console side cannot open commands');
    },
  };
}

/** Opens with the app's X25519 command key pair (derived from its `APP_KEY`): the app side. */
function appKeySealer(keys: ConsoleCommandKeys): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith(APP_KEY_SEAL),
    seal: (plaintext, aad) => appKeySealerTo(keys.publicKey).seal(plaintext, aad),
    async open(sealed, aad) {
      const raw = Buffer.from(sealed.slice(APP_KEY_SEAL.length), 'base64url');
      if (raw.length < 32 + 12 + 16) throw new Error('sealed command too short');
      const epk = raw.subarray(0, 32);
      const shared = diffieHellman({
        privateKey: keys.privateKey,
        publicKey: x25519Public(epk.toString('base64url')),
      });
      const key = sealKey(shared, epk, Buffer.from(keys.publicKey, 'base64url'));
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(32, 44));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(raw.subarray(44, 60));
      return Buffer.concat([decipher.update(raw.subarray(60)), decipher.final()]).toString('utf8');
    },
  };
}

/** The key that MACs the answers to one command: a secret only the console and the app know. */
function replyKey(secret: string, prefix: string, id: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`agora:console-reply:${CONSOLE_TOPIC}:${prefix}:${id}`)
    .digest();
}

const commandAad = (prefix: string, id: string) =>
  JSON.stringify(['agora:console-command', CONSOLE_TOPIC, prefix, id]);

/** A token source, normalized: `get` and, when the source can, `reset` (after a `401`). */
function resolveToken(source: ConsoleTokenSource): { get(): Promise<string>; reset?(): void } {
  if (typeof source === 'string') {
    if (source === '') throw new Error(`[${PACKAGE}] console commands: the token is empty`);
    return { get: async () => source };
  }
  if (typeof source === 'function') {
    // `authkitTenantToken` caches its token and exposes `reset()` to drop it.
    const reset = (source as { reset?: unknown }).reset;
    return {
      get: async () => source(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  if (source && typeof source === 'object' && typeof source.get === 'function') {
    const reset = source.reset ?? source.invalidate;
    return {
      get: async () => source.get(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  throw new Error(
    `[${PACKAGE}] console commands: a token must be a string, a function returning one, or an object with get()`,
  );
}

/**
 * Sealed mode (console side): the whole command, with the console's token when it has one, travels
 * sealed so only the owning app opens it. A Redis reader sees an id and ciphertext: no token to lift
 * and replay, no command to alter. The sealed payload also carries a one-off secret the app MACs its
 * answer with, so a forged answer (from someone who cannot open the command) is ignored.
 */
class SealedSender implements ChannelMode {
  readonly #token: ReturnType<typeof resolveToken> | undefined;
  constructor(
    readonly sealer: ConsoleSealer,
    token: ConsoleTokenSource | undefined,
    readonly prefix: string,
    readonly tokenOptional = false,
  ) {
    this.#token = token === undefined ? undefined : resolveToken(token);
  }

  async wrap(command: WireConsoleCommand): Promise<OutgoingConsoleMessage> {
    let token: string | undefined;
    try {
      token = this.#token ? await this.#token.get() : undefined;
    } catch (error) {
      // Crypto mode: the token only narrows; without it the command still goes, sealed.
      if (!this.tokenOptional) throw error;
      token = undefined;
    }
    const secret = randomBytes(32).toString('base64url');
    const { mac: _mac, verified: _verified, ...fields } = command;
    const sealed = await this.sealer.seal(
      JSON.stringify({
        command: { ...fields, ts: Date.now() },
        ...(token !== undefined ? { token } : {}),
        replySecret: secret,
      }),
      commandAad(this.prefix, command.id),
    );
    const key = replyKey(secret, this.prefix, command.id);
    return {
      wire: { id: command.id, sealed },
      verifyReply: (reply) => sameMac(macOf(key, 'reply', replyFields(reply)), reply.mac),
    };
  }

  unauthorized(): void {
    this.#token?.reset?.();
  }
}

/**
 * Sealed mode (app side): open, check freshness and — when `verifyTenant` is set — verify the token
 * the command carries. A command without a token is accepted only when no `verifyTenant` is set
 * (crypto mode: whoever may encrypt with the key is the console, like a shared secret).
 */
class SealedReceiver implements ChannelMode {
  constructor(
    readonly label: string,
    readonly sealer: ConsoleSealer,
    readonly verify: ConsoleTokenVerifier | undefined,
    readonly prefix: string,
    /** Accept a command without a token (a token it does carry is still verified). */
    readonly tokenOptional = false,
  ) {}

  async unwrap(wire: Record<string, unknown>): Promise<IncomingConsoleMessage | null> {
    if (typeof wire.sealed !== 'string' || typeof wire.id !== 'string') return null;
    if (!this.sealer.owns(wire.sealed)) return null;
    const id = wire.id;
    let payload: { command?: WireConsoleCommand; token?: unknown; replySecret?: unknown };
    try {
      payload = JSON.parse(
        await this.sealer.open(wire.sealed, commandAad(this.prefix, id)),
      ) as typeof payload;
    } catch {
      throw refusedCommand("did not open with this app's key");
    }
    const command = payload?.command;
    if (
      !command ||
      typeof command !== 'object' ||
      command.id !== id ||
      typeof command.verb !== 'string' ||
      typeof payload.replySecret !== 'string'
    ) {
      throw refusedCommand("did not open with this app's key");
    }
    if (!fresh(command.ts)) throw refusedCommand('stale');
    const key = replyKey(payload.replySecret, this.prefix, id);
    const signReply = (reply: WireConsoleReply): WireConsoleReply => {
      const { mac: _mac, ...rest } = reply;
      return { ...rest, mac: macOf(key, 'reply', replyFields(rest)) } as WireConsoleReply;
    };
    const { mac: _mac, ts: _ts, verified: _claimed, ...fields } = command;
    if (!this.verify) return { id, signReply, command: fields };
    const hasToken = typeof payload.token === 'string' && payload.token !== '';
    if (!hasToken && this.tokenOptional) return { id, signReply, command: fields };

    let verified: VerifiedToken | null = null;
    try {
      verified = hasToken ? await this.verify({ token: payload.token as string }) : null;
    } catch {
      verified = null;
    }
    if (!verified || typeof verified.partition !== 'string' || verified.partition === '') {
      return {
        id,
        signReply,
        error: {
          message: `the console's token was refused by the "${this.prefix}" app`,
          code: UNAUTHORIZED_CONSOLE,
          status: 401,
        },
      };
    }
    const capabilities = Array.isArray(verified.capabilities)
      ? verified.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    return {
      id,
      signReply,
      command: {
        ...fields,
        verified: {
          partition: verified.partition,
          capabilities,
          ...(verified.appCall === true ? { appCall: true } : {}),
          ...(typeof verified.clientId === 'string' ? { clientId: verified.clientId } : {}),
        },
      },
    };
  }
}

/**
 * One side's authentication of console commands on the control plane of `prefix`: how it sends (one
 * mode: crypto, else a token sealed to the app's key, else the secret) and every way it accepts
 * commands (an app may accept several while its consoles move from one to another).
 */
export class ConsoleCommandAuth {
  readonly #sender: ChannelMode | undefined;
  readonly #receivers: ChannelMode[];

  constructor(options: ConsoleCommandAuthOptions & { prefix: string }) {
    const { prefix } = options;
    const secret =
      options.secret === undefined ? undefined : new SecretMode(options.secret, prefix);
    const crypto = options.crypto ? cryptoSealer(options.crypto) : undefined;

    // Sending: crypto when configured, else a token sealed to the app's key, else the secret.
    if (options.token !== undefined && !crypto && options.publicKey === undefined) {
      throw new Error(
        `[${PACKAGE}] console commands: a \`token\` needs \`crypto\` or the app's \`publicKey\` (print it there with \`node ace durable:console-key\`)`,
      );
    }
    if (typeof options.publicKey === 'string') x25519Public(options.publicKey);
    const sendSealer =
      crypto ?? (options.publicKey !== undefined ? appKeySealerTo(options.publicKey) : undefined);
    const sealedSender =
      sendSealer && (crypto || options.token !== undefined)
        ? new SealedSender(sendSealer, options.token, prefix, options.tokenOptional === true)
        : undefined;
    this.#sender = sealedSender ?? secret;

    // Answering: every configured way. Without crypto, sealed commands need a token check.
    const receivers: ChannelMode[] = [];
    if (crypto) {
      receivers.push(
        new SealedReceiver(
          `crypto (key ${options.crypto?.key ?? CONSOLE_CRYPTO_KEY})`,
          crypto,
          options.verifyTenant,
          prefix,
          options.crypto?.requireToken === false,
        ),
      );
    }
    if (options.appKey !== undefined && options.verifyTenant !== undefined) {
      const keys = consoleCommandKeys(options.appKey, prefix);
      receivers.push(
        new SealedReceiver(
          `token (sealed to ${consoleKeyId(keys.publicKey)})`,
          appKeySealer(keys),
          options.verifyTenant,
          prefix,
        ),
      );
    }
    if (secret) receivers.push(secret);
    this.#receivers = receivers;
  }

  /** Whether this side can send commands. */
  get canSend(): boolean {
    return this.#sender?.wrap !== undefined;
  }

  /** Whether this side accepts commands in at least one mode. */
  get canAnswer(): boolean {
    return this.#receivers.length > 0;
  }

  /** `command` as it goes on the wire, and how to recognise the app's answer to it. */
  async wrap(command: WireConsoleCommand): Promise<OutgoingConsoleMessage> {
    if (!this.#sender?.wrap) throw unsignedError();
    return this.#sender.wrap(command);
  }

  /**
   * The command `wire` carries, once one of the accepted modes authenticates it. Throws a
   * {@link ConsoleChannelError} for a message no mode accepts (unsigned, forged, stale, tampered).
   */
  async unwrap(wire: Record<string, unknown>): Promise<IncomingConsoleMessage> {
    for (const receiver of this.#receivers) {
      const incoming = (await receiver.unwrap?.(wire)) ?? null;
      if (incoming) return incoming;
    }
    const accepts = this.#receivers.map((receiver) => receiver.label ?? 'unknown').join(', ');
    throw refusedCommand(
      `mode not accepted here (this app accepts: ${accepts}; the command came as ${commandMode(wire)})`,
    );
  }

  /** The app refused the token: drop the cached one, so the next command fetches a fresh token. */
  unauthorized(): void {
    this.#sender?.unauthorized?.();
  }
}

/** How a received command presents itself, for a refusal (never its content). */
function commandMode(wire: Record<string, unknown>): string {
  if (typeof wire.sealed === 'string') {
    const crypto = /^agora:ct1:([^:]+):/.exec(wire.sealed);
    if (crypto) return `crypto (key ${crypto[1]})`;
    if (wire.sealed.startsWith(APP_KEY_SEAL)) return 'token (sealed to an app key)';
    return 'sealed (unknown format)';
  }
  if (typeof wire.mac === 'string') return 'secret';
  return 'unsigned';
}

/** The error a control plane with no authentication answers every send and answer with. */
export function unsignedError(prefix?: string): ConsoleChannelError {
  return new ConsoleChannelError(
    `the ${prefix ? `"${prefix}" ` : ''}durable control plane has no authentication for console commands; use @adonis-agora/crypto (\`crypto\` on both sides), authkit (a \`token\` on the console, \`verifyTenant\` on the app) or the same \`secret\` on both`,
    UNSIGNED_CHANNEL,
  );
}

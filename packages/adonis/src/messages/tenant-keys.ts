import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomUUID,
} from 'node:crypto';
import type { AppKey } from '../app_key.js';
import type { CryptoRuntimeLike } from '../control-plane-redis/console-crypto.js';
import type { RunReply, RunRequest } from '../interfaces.js';

/**
 * Message keys owned by the durable control plane (1.3).
 *
 * Between a tenant pod and its control plane every message is sealed with a key the CONTROL PLANE
 * owns, one per tenant partition: `K_tenant = HKDF(root(partition))`, where the root is
 * - an HMAC of the partition under the control plane's `@adonis-agora/crypto` key
 *   `durable-message-keys` (crypto embedded in the Hub, or a crypto server the Hub is a tenant of),
 * - else HKDF over the control plane's own `APP_KEY`.
 * Tenants need nothing beyond what tenant topology already requires (their token): on first use a
 * tenant sends the control plane an ephemeral X25519 public key in a `messageKey` run request
 * (authenticated with its token, like every run request); the control plane answers with `K_tenant`
 * sealed to that key (ECDH-ES + HKDF-SHA256 + AES-256-GCM). The key lives in memory only, never on
 * the broker in clear. Every message carries the key id (`kid`); a control plane that rotates gets
 * a new kid, and a tenant that sees one it does not hold asks again.
 */

const PACKAGE = '@adonis-agora/durable';
const DOCS = 'https://davidecarvalho.github.io/agora/docs/durable/transports/encrypting-messages';

/** The `@adonis-agora/crypto` key (HMAC-SHA256) the control plane derives its tenants' keys from. */
export const CONTROL_PLANE_KEYS_CRYPTO_KEY = 'durable-message-keys';

/** The run-request verb a tenant asks for its message key with. */
export const MESSAGE_KEY_REQUEST = 'messageKey';

/** How old a `messageKey` request may be. */
const HANDSHAKE_MAX_AGE_MS = 60_000;
/** How long a tenant waits for its key. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** How often a control plane re-reads its crypto key's id (a rotation shows as a new kid). */
const KID_REFRESH_MS = 5 * 60_000;

const b64 = (buf: Buffer): string => buf.toString('base64url');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64url');

function derive(secret: Buffer | string, info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'agora:durable:messages:cp', info, length));
}

function release(key: AppKey): string {
  return typeof key === 'string' ? key : key.release();
}

/* ------------------------------------------------------------------------------------------- */
/* The control plane's root                                                                    */
/* ------------------------------------------------------------------------------------------- */

/** Where the control plane's per-tenant keys come from. */
export interface ControlPlaneRoot {
  /** `app key` or `crypto (key durable-message-keys)`, for the boot line and the doctor. */
  readonly label: string;
  /** The current key id. */
  kid(): Promise<string>;
  /** `K_partition` under the current root, with its kid. */
  current(partition: string): Promise<{ kid: string; key: Buffer }>;
  /** `K_partition` under the root `kid` names (current or previous), if this process has it. */
  byKid(partition: string, kid: string): Promise<Buffer | undefined>;
}

/** The control plane's root from its own `APP_KEY`. */
export function appKeyRoot(appKey: AppKey): ControlPlaneRoot {
  const secret = release(appKey);
  const kid = b64(derive(secret, 'agora:durable:messages:kid', 6));
  const cache = new Map<string, Buffer>();
  const keyFor = (partition: string): Buffer => {
    let key = cache.get(partition);
    if (!key) {
      key = derive(secret, `agora:durable:messages:${partition}`);
      if (cache.size >= 10_000) cache.clear();
      cache.set(partition, key);
    }
    return key;
  };
  return {
    label: 'control plane keys (app key)',
    kid: async () => kid,
    current: async (partition) => ({ kid, key: keyFor(partition) }),
    byKid: async (partition, wanted) => (wanted === kid ? keyFor(partition) : undefined),
  };
}

type Hmac = (message: string) => Promise<string>;

/**
 * The crypto partition `durable-message-keys` lives in when this app runs the crypto server as a
 * control plane. Such a crypto control plane has no app of its own (its runtime's partition is `''`,
 * which every crypto operation refuses: "the token names no partition"), so durable names one, the
 * way the console sides name the app partition of a `console-<lib>` key. The leading `_` keeps it
 * out of reach of every tenant: an authkit partition starts with a letter or a digit, so no tenant
 * token (and its `crypto:*` over its own partition) can ever address this one.
 */
export const CONTROL_PLANE_KEYS_PARTITION = '_durable';

/**
 * The partition the control plane's key is used in: crypto's own partition when it has one (a
 * standalone crypto app, or a crypto tenant: its token's partition), else {@link CONTROL_PLANE_KEYS_PARTITION}.
 */
export function controlPlaneKeysPartition(runtime: Pick<CryptoRuntimeLike, 'partition'>): string {
  return runtime.partition !== '' ? runtime.partition : CONTROL_PLANE_KEYS_PARTITION;
}

/** The `hmac` of `@adonis-agora/crypto` on the control plane's keys partition, if crypto offers it. */
export function cryptoHmacOf(runtime: CryptoRuntimeLike): Hmac | undefined {
  const service = runtime.service as
    | (NonNullable<CryptoRuntimeLike['service']> & {
        hmac?(
          principal: unknown,
          input: { key: string; message: string },
        ): Promise<{ hmac: string }>;
      })
    | undefined;
  if (typeof service?.hmac === 'function') {
    const principal = {
      partition: controlPlaneKeysPartition(runtime),
      capabilities: [`crypto:hmac:${CONTROL_PLANE_KEYS_CRYPTO_KEY}`],
      actor: 'durable:messages',
    };
    return async (message) =>
      (await service.hmac?.(principal, { key: CONTROL_PLANE_KEYS_CRYPTO_KEY, message }))?.hmac ??
      '';
  }
  const operations = runtime.operations as CryptoRuntimeLike['operations'] & {
    hmac?(input: { key: string; message: string }): Promise<{ hmac: string }>;
  };
  if (typeof operations.hmac === 'function') {
    return async (message) =>
      (await operations.hmac?.({ key: CONTROL_PLANE_KEYS_CRYPTO_KEY, message }))?.hmac ?? '';
  }
  return undefined;
}

/**
 * The control plane's root from `@adonis-agora/crypto`: `root(partition) = HMAC(durable-message-keys,
 * partition)`, so every replica derives the same keys and nothing is stored. A rotation of the crypto
 * key changes the HMACs, hence the kid; the keys of the previous kid stay usable in this process.
 */
export function cryptoRoot(hmac: Hmac, clock: () => number = () => Date.now()): ControlPlaneRoot {
  let kidAt = 0;
  let currentKid: Promise<string> | undefined;
  const kids = new Map<string, Map<string, Promise<Buffer>>>();
  const keysOf = (kid: string) => {
    let byPartition = kids.get(kid);
    if (!byPartition) {
      byPartition = new Map();
      kids.set(kid, byPartition);
      // The current kid and the previous one.
      while (kids.size > 2) kids.delete(kids.keys().next().value as string);
    }
    return byPartition;
  };
  const kid = (): Promise<string> => {
    if (!currentKid || clock() - kidAt > KID_REFRESH_MS) {
      kidAt = clock();
      const next = hmac('agora:durable:messages:kid').then((h) => {
        if (!h) throw new Error('the crypto hmac returned nothing');
        return b64(createHash('sha256').update(h).digest()).slice(0, 8);
      });
      next.catch(() => {
        currentKid = undefined;
      });
      currentKid = next;
    }
    return currentKid;
  };
  const keyFor = async (k: string, partition: string): Promise<Buffer> => {
    const byPartition = keysOf(k);
    let key = byPartition.get(partition);
    if (!key) {
      key = hmac(`agora:durable:messages:${partition}`).then(async (h) => {
        // The HMAC must be of the key `k` names: a rotation between the two calls is caught here.
        if ((await kid()) !== k) throw new Error('the crypto key rotated meanwhile');
        return derive(h, `agora:durable:messages:${partition}`);
      });
      key.catch(() => byPartition.delete(partition));
      byPartition.set(partition, key);
    }
    return key;
  };
  return {
    label: `control plane keys (crypto, key ${CONTROL_PLANE_KEYS_CRYPTO_KEY})`,
    kid,
    current: async (partition) => {
      const k = await kid();
      return { kid: k, key: await keyFor(k, partition) };
    },
    byKid: async (partition, wanted) => {
      const k = await kid();
      if (wanted === k) return keyFor(k, partition);
      return kids.get(wanted)?.get(partition);
    },
  };
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * On a control plane with crypto: makes sure `durable-message-keys` exists in
 * {@link controlPlaneKeysPartition}, creating it when missing. Never throws: returns why it could not,
 * or `undefined` when the key is there (or was just created, logged once at info).
 */
export async function ensureControlPlaneKey(
  runtime: CryptoRuntimeLike,
  log: (level: 'info' | 'warn', line: string) => void,
): Promise<string | undefined> {
  const key = CONTROL_PLANE_KEYS_CRYPTO_KEY;
  const partition = controlPlaneKeysPartition(runtime);
  const description = `${PACKAGE}: derives the message keys of the control plane's tenants`;
  const created = () =>
    log('info', `[${PACKAGE}] messages: created the crypto key "${key}" in partition ${partition}`);
  try {
    const service = runtime.service;
    if (service) {
      if (await service.store.getKey(partition, key)) return undefined;
      try {
        await service.createKey(
          { partition, capabilities: [`crypto:keys:manage:${key}`], actor: 'durable:messages' },
          { name: key, type: 'hmac-sha256', description },
        );
      } catch (error) {
        // Created meanwhile by another replica: what was wanted.
        if (await service.store.getKey(partition, key)) return undefined;
        throw error;
      }
      created();
      return undefined;
    }
    const operations = runtime.operations;
    if (typeof operations.hasKey === 'function' && (await operations.hasKey({ key }))) {
      return undefined;
    }
    if (typeof operations.createKey !== 'function') throw new Error('no createKey');
    await operations.createKey({ name: key, type: 'hmac-sha256', description });
    created();
    return undefined;
  } catch (error) {
    return errorText(error);
  }
}

/** The one actionable line when the control plane falls back to its APP_KEY. */
export function controlPlaneKeyFallbackLine(
  runtime: Pick<CryptoRuntimeLike, 'partition' | 'service'>,
  reason: string,
  fallback: 'app key' | 'none',
): string {
  const key = CONTROL_PLANE_KEYS_CRYPTO_KEY;
  const partition = controlPlaneKeysPartition(runtime);
  const create = `\`node ace crypto:keys:create ${key} --type hmac-sha256 --application ${partition}\``;
  const fix = runtime.service
    ? `create it: ${create}`
    : `create it on the crypto server (${create}) and grant this app's crypto client \`crypto:hmac:${key}\` (or \`crypto:keys:manage:${key}\` so it creates it)`;
  const then =
    fallback === 'app key'
      ? "so this process derives its tenants' message keys from its APP_KEY (HKDF) instead. Every replica of the control plane must derive them the same way: "
      : 'and this app has no APP_KEY to fall back to, so sealed messages to and from its tenants fail. ';
  return `[${PACKAGE}] messages: the control plane cannot use the crypto key "${key}" in partition ${partition} (${reason}), ${then}${fix}, then restart. Docs: ${DOCS}`;
}

/**
 * The control plane's root, resolved on the FIRST key request (a seal, an open, a tenant asking for
 * its key), never at boot: with sealing off and no tenant asking, crypto is never called. Then:
 * crypto's `durable-message-keys` (created when missing) when it answers, else HKDF over `APP_KEY`
 * with one warning. The choice holds for the life of the process (a root that changed under running
 * tenants would change every kid); a failure without an `APP_KEY` is retried on the next request.
 */
export function lazyControlPlaneRoot(input: {
  runtime: CryptoRuntimeLike | undefined;
  appKey: AppKey | undefined;
  log: (level: 'info' | 'warn', line: string) => void;
}): ControlPlaneRoot {
  const { runtime, appKey, log } = input;
  const hmac = runtime ? cryptoHmacOf(runtime) : undefined;
  if (!runtime || !hmac) {
    const fallback = appKeyRoot(appKey as AppKey);
    if (!runtime) return fallback;
    // Crypto too old to HMAC: said on first use, like the rest.
    let warned = false;
    const warnOnce = () => {
      if (warned) return;
      warned = true;
      log(
        'warn',
        `[${PACKAGE}] messages: @adonis-agora/crypto is booted here but offers no \`hmac\` (an older version): the tenants' message keys derive from this app's APP_KEY instead. Upgrade @adonis-agora/crypto to keep them in crypto. Docs: ${DOCS}`,
      );
    };
    return {
      label: fallback.label,
      kid: async () => {
        warnOnce();
        return fallback.kid();
      },
      current: async (partition) => {
        warnOnce();
        return fallback.current(partition);
      },
      byKid: async (partition, kid) => {
        warnOnce();
        return fallback.byKid(partition, kid);
      },
    };
  }
  const crypto = cryptoRoot(hmac);
  let resolving: Promise<ControlPlaneRoot> | undefined;
  let lastLine: string | undefined;
  const resolve = (): Promise<ControlPlaneRoot> => {
    if (!resolving) {
      resolving = (async () => {
        const missing = await ensureControlPlaneKey(runtime, log);
        let reason = missing;
        try {
          await crypto.kid();
          return crypto;
        } catch (error) {
          reason ??= errorText(error);
        }
        const line = controlPlaneKeyFallbackLine(
          runtime,
          reason,
          appKey === undefined ? 'none' : 'app key',
        );
        if (line !== lastLine) log('warn', line);
        lastLine = line;
        if (appKey === undefined) throw new Error(line);
        return appKeyRoot(appKey);
      })();
      resolving.catch(() => {
        resolving = undefined;
      });
    }
    return resolving;
  };
  return {
    label: crypto.label,
    kid: async () => (await resolve()).kid(),
    current: async (partition) => (await resolve()).current(partition),
    byKid: async (partition, kid) => (await resolve()).byKid(partition, kid),
  };
}

/* ------------------------------------------------------------------------------------------- */
/* The handshake                                                                               */
/* ------------------------------------------------------------------------------------------- */

/** The body of a `messageKey` run request. */
export interface MessageKeyRequestBody {
  kind: typeof MESSAGE_KEY_REQUEST;
  /** The tenant's ephemeral X25519 public key (raw, base64url). */
  publicKey: string;
  /** The partition the tenant asks for: must be the one its token verifies to. */
  partition: string;
  /** When the request was made (ms): one over a minute old is refused. */
  ts: number;
  /** A fresh random value (16+ characters): a request seen before is refused as a replay. */
  nonce: string;
}

/** What the control plane answers: `K_tenant` sealed to the request's key. */
export interface MessageKeyGrant {
  kid: string;
  /** The control plane's ephemeral X25519 public key (raw, base64url). */
  epk: string;
  /** iv | tag | AES-256-GCM(K_tenant), base64url. */
  ct: string;
}

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

function publicKeyObject(raw: string): KeyObject {
  const bytes = unb64(raw);
  if (bytes.length !== 32) throw new Error('not an X25519 public key');
  return createPublicKey({ key: Buffer.concat([X25519_SPKI, bytes]), format: 'der', type: 'spki' });
}

function rawPublicKey(key: KeyObject): string {
  return b64((key.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
}

function grantAad(requestId: string, partition: string, kid: string): Buffer {
  return Buffer.from(JSON.stringify(['agora:durable:message-key', requestId, partition, kid]));
}

function wrapKey(shared: Buffer, epk: string, publicKey: string, aad: Buffer): Buffer {
  return derive(
    Buffer.concat([shared, unb64(epk), unb64(publicKey)]),
    `agora:durable:message-key-wrap:${aad.toString('base64url')}`,
  );
}

/** Control plane side: `key` sealed to the tenant's `publicKey`. */
export function grantKey(
  input: { publicKey: string; requestId: string; partition: string; kid: string },
  key: Buffer,
): MessageKeyGrant {
  const theirs = publicKeyObject(input.publicKey);
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const epk = rawPublicKey(publicKey);
  const shared = diffieHellman({ privateKey, publicKey: theirs });
  const aad = grantAad(input.requestId, input.partition, input.kid);
  const wrap = wrapKey(shared, epk, input.publicKey, aad);
  const iv = Buffer.from(hkdfSync('sha256', wrap, '', 'iv', 12));
  const gcm = createCipheriv('aes-256-gcm', wrap, iv);
  gcm.setAAD(aad);
  const body = Buffer.concat([gcm.update(key), gcm.final()]);
  return { kid: input.kid, epk, ct: b64(Buffer.concat([iv, gcm.getAuthTag(), body])) };
}

/** Tenant side: an ephemeral key pair to ask with. */
export function handshakeKeyPair(): { publicKey: string; privateKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { publicKey: rawPublicKey(publicKey), privateKey };
}

/** Tenant side: `K_tenant` out of the control plane's grant, or `null` when it does not open. */
export function openGrant(
  grant: MessageKeyGrant,
  mine: { publicKey: string; privateKey: KeyObject },
  requestId: string,
  partition: string,
): Buffer | null {
  try {
    const shared = diffieHellman({
      privateKey: mine.privateKey,
      publicKey: publicKeyObject(grant.epk),
    });
    const aad = grantAad(requestId, partition, grant.kid);
    const wrap = wrapKey(shared, grant.epk, mine.publicKey, aad);
    const raw = unb64(grant.ct);
    if (raw.length !== 12 + 16 + 32) return null;
    const gcm = createDecipheriv('aes-256-gcm', wrap, raw.subarray(0, 12));
    gcm.setAAD(aad);
    gcm.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([gcm.update(raw.subarray(28)), gcm.final()]);
  } catch {
    return null;
  }
}

/** Whether `body` is a well-formed, fresh `messageKey` request body. */
export function isMessageKeyBody(body: unknown, now = Date.now()): body is MessageKeyRequestBody {
  const b = body as Partial<MessageKeyRequestBody> | null;
  return (
    !!b &&
    b.kind === MESSAGE_KEY_REQUEST &&
    isPublicKey(b.publicKey) &&
    typeof b.partition === 'string' &&
    typeof b.ts === 'number' &&
    typeof b.nonce === 'string' &&
    b.nonce.length >= 16 &&
    b.nonce.length <= 128 &&
    now - b.ts <= HANDSHAKE_MAX_AGE_MS &&
    b.ts - now <= HANDSHAKE_MAX_AGE_MS
  );
}

/** Whether a message is a `messageKey` request (sent and accepted plain: it bootstraps the key). */
export function isMessageKeyRequest(raw: unknown): boolean {
  return (
    (raw as { body?: { kind?: unknown } } | null)?.body?.kind === MESSAGE_KEY_REQUEST &&
    typeof (raw as { requestId?: unknown }).requestId === 'string'
  );
}

/** Whether a run-reply id is a `messageKey` answer's (every key request id starts `mk-`). */
export function isMessageKeyReplyId(requestId: unknown): boolean {
  return typeof requestId === 'string' && requestId.startsWith('mk-');
}

/** Whether `raw` is a well-formed X25519 public key (32 bytes, base64url). */
export function isPublicKey(raw: unknown): boolean {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return false;
  return Buffer.from(raw, 'base64url').length === 32;
}

/* ------------------------------------------------------------------------------------------- */
/* Single use                                                                                  */
/* ------------------------------------------------------------------------------------------- */

/** How long one token's key request blocks another with the same token when the token says nothing. */
const TOKEN_HOLD_FALLBACK_MS = HANDSHAKE_MAX_AGE_MS;
/** The most a token's key request blocks another (a long-lived JWT). */
const TOKEN_HOLD_MAX_MS = 24 * 60 * 60_000;

/** A token's identity for the guard (its `jti` when it is a JWT, else a hash) and remaining lifetime. */
export function tokenIdentity(token: string, now = Date.now()): { id: string; holdMs: number } {
  const hash = createHash('sha256').update(token).digest('base64url').slice(0, 32);
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as {
        jti?: unknown;
        exp?: unknown;
      };
      const id =
        typeof claims.jti === 'string' && claims.jti.length > 0 ? `jti:${claims.jti}` : `h:${hash}`;
      const holdMs =
        typeof claims.exp === 'number'
          ? Math.min(TOKEN_HOLD_MAX_MS, Math.max(TOKEN_HOLD_FALLBACK_MS, claims.exp * 1000 - now))
          : TOKEN_HOLD_FALLBACK_MS;
      return { id, holdMs };
    } catch {
      // not a JWT
    }
  }
  return { id: `h:${hash}`, holdMs: TOKEN_HOLD_FALLBACK_MS };
}

/** "Set if absent" for a while, shared by every control-plane replica (Redis `SET NX PX`, the DB). */
export type ClaimOnce = (key: string, ttlMs: number) => Promise<boolean>;

/** A per-process {@link ClaimOnce}, for a transport with no shared store. */
export function memoryClaimOnce(): ClaimOnce {
  const held = new Map<string, number>();
  return async (key, ttlMs) => {
    const now = Date.now();
    for (const [k, until] of held) if (until <= now) held.delete(k);
    if ((held.get(key) ?? 0) > now) return false;
    held.set(key, now + ttlMs);
    return true;
  };
}

/**
 * Makes every key request single-use: a request (token + nonce) seen before is refused, and so is a
 * second key request with the same token while that token lives. A captured request or token
 * replayed by someone reading the broker either loses the race to the pod (and is refused) or wins
 * it, and then the pod's own request is refused and reported as a possible replay.
 */
export class MessageKeyGuard {
  readonly #claim: ClaimOnce;
  readonly #warn: (line: string) => void;
  readonly #warned = new Set<string>();

  constructor(claim: ClaimOnce, warn: (line: string) => void) {
    this.#claim = claim;
    this.#warn = warn;
  }

  /** `null` when the request may proceed, else why it is refused. */
  async check(
    token: string,
    body: MessageKeyRequestBody,
  ): Promise<{ code: 'replayed' | 'unavailable'; message: string } | null> {
    const { id, holdMs } = tokenIdentity(token);
    try {
      const replayed = await this.#check(id, holdMs, body);
      return replayed ? { code: 'replayed', message: replayed } : null;
    } catch (error) {
      // Fail closed: without the shared store no key is handed out.
      return {
        code: 'unavailable',
        message: `the replay guard's store is unavailable (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }

  async #check(id: string, holdMs: number, body: MessageKeyRequestBody): Promise<string | null> {
    if (!(await this.#claim(`durable-mk:nonce:${id}:${body.nonce}`, 2 * HANDSHAKE_MAX_AGE_MS))) {
      this.#report(body.partition, 'a message-key request was sent twice (same token and nonce)');
      return 'this message-key request was already answered (replayed)';
    }
    if (!(await this.#claim(`durable-mk:token:${id}`, holdMs))) {
      this.#report(body.partition, 'a second message-key request used the same tenant token');
      return 'this token already asked for its message key (replayed? ask again with a fresh token)';
    }
    return null;
  }

  #report(partition: string, what: string): void {
    if (this.#warned.has(partition)) return;
    this.#warned.add(partition);
    this.#warn(
      `[${PACKAGE}] messages: ${what} for partition "${partition}": possibly a replay by someone who read the token. Refused. If it was the pod itself (restarted within the token's lifetime), it asks again with a fresh token. Further cases for this partition are not logged.`,
    );
  }
}

/** The plumbing a tenant's handshake needs from its transport. */
export interface HandshakeWire {
  dispatchRunRequest(msg: RunRequest): Promise<void>;
}

/**
 * Tenant side: holds this pod's key, asks the control plane for it on first use (and again when the
 * control plane rotates), through the transport it is attached to.
 */
/** The control plane's HTTPS route for key requests (under its URL). */
export const MESSAGE_KEY_PATH = '/__durable/message-key';

/** The key route under the control plane's `base` URL, or `undefined` for something not a URL. */
function keyUrl(base: string): URL | undefined {
  try {
    return new URL(MESSAGE_KEY_PATH, base.endsWith('/') ? base : `${base}/`);
  } catch {
    return undefined;
  }
}

/** Whether a pod may ask for its key at `base`: HTTPS, or plain HTTP to this machine only. */
export function usableKeyUrl(base: string): boolean {
  const target = keyUrl(base);
  if (!target) return false;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  return target.protocol === 'https:' || (local && target.protocol === 'http:');
}

/** The answer of a key request, over either path. */
type KeyAnswer = RunReply['result'];

/**
 * Tenant side: holds this pod's key, asks the control plane for it on first use (and again when the
 * control plane rotates). Over HTTPS to the control plane's URL when the pod has one (the token then
 * never crosses the broker for this), else over the run-request channel of the transport.
 */
export class TenantKeyClient {
  readonly #partition: string;
  readonly #token: () => Promise<string>;
  readonly #resetToken: (() => boolean | undefined | void) | undefined;
  readonly #url: (() => Promise<string | undefined>) | undefined;
  readonly #fetch: typeof fetch;
  #wire: HandshakeWire | undefined;
  #current: Promise<{ kid: string; key: Buffer }> | undefined;
  readonly #keys = new Map<string, Buffer>();
  readonly #pending = new Map<string, (reply: RunReply) => void>();
  readonly #log: (level: 'info' | 'warn', line: string) => void;
  /** Whether the HTTPS failure was logged (warned once; HTTPS is tried again on every handshake). */
  #httpsWarned = false;
  /** How the last key was obtained: `https` or `broker` (doctor, tests). */
  lastPath: 'https' | 'broker' | undefined;

  constructor(options: {
    partition: string;
    token: () => Promise<string>;
    resetToken?: (() => boolean | undefined | void) | undefined;
    url?: (() => Promise<string | undefined>) | undefined;
    fetch?: typeof fetch | undefined;
    log: (level: 'info' | 'warn', line: string) => void;
  }) {
    this.#partition = options.partition;
    this.#token = options.token;
    this.#resetToken = options.resetToken;
    this.#url = options.url;
    this.#fetch = options.fetch ?? fetch;
    this.#log = options.log;
  }

  get partition(): string {
    return this.#partition;
  }

  attach(wire: HandshakeWire): void {
    this.#wire = wire;
  }

  /** A reply to one of this client's handshakes: consumed here. */
  takeReply(reply: RunReply): boolean {
    const resolve = this.#pending.get(reply.requestId);
    if (!resolve) return false;
    this.#pending.delete(reply.requestId);
    resolve(reply);
    return true;
  }

  /** Whether `requestId` is one of this client's pending handshakes. */
  isHandshake(requestId: unknown): boolean {
    return typeof requestId === 'string' && this.#pending.has(requestId);
  }

  current(): Promise<{ kid: string; key: Buffer }> {
    if (!this.#current) {
      const next = this.#handshake();
      next.catch(() => {
        if (this.#current === next) this.#current = undefined;
      });
      this.#current = next;
    }
    return this.#current;
  }

  /** The key `kid` names; a kid this pod does not hold (a rotation) triggers one new handshake. */
  async byKid(kid: string): Promise<Buffer | undefined> {
    const known = this.#keys.get(kid);
    if (known) return known;
    const current = await this.current();
    if (current.kid === kid) return current.key;
    // The control plane rotated: ask again, once.
    this.#current = undefined;
    const fresh = await this.current().catch(() => undefined);
    return fresh?.kid === kid ? fresh.key : undefined;
  }

  async #handshake(): Promise<{ kid: string; key: Buffer }> {
    let answer = await this.#ask();
    if (!answer.result.ok && answer.result.error.code === 'replayed') {
      // This token already asked (a restart within its lifetime, or a replay someone else won):
      // ask once more with a fresh token when the source can mint one (a reset that answers
      // `false` had nothing to drop), else after the window an opaque token is held for.
      const reset = this.#resetToken?.();
      if (!this.#resetToken || reset === false) {
        await new Promise((r) => setTimeout(r, HANDSHAKE_MAX_AGE_MS + 1_000).unref?.());
      }
      answer = await this.#ask();
    }
    const { result, requestId, mine } = answer;
    if (!result.ok) {
      const error = new Error(
        `[${PACKAGE}] messages: the control plane refused this pod's message key: ${result.error.message}`,
      );
      this.#log('warn', error.message);
      throw error;
    }
    const grant = result.data as MessageKeyGrant;
    const key = grant && openGrant(grant, mine, requestId, this.#partition);
    if (!key)
      throw new Error(`[${PACKAGE}] messages: the control plane's message key did not open`);
    this.#keys.set(grant.kid, key);
    while (this.#keys.size > 2) this.#keys.delete(this.#keys.keys().next().value as string);
    return { kid: grant.kid, key };
  }

  /** One key request, over HTTPS when the pod has the control plane's URL, else the broker. */
  async #ask(): Promise<{
    result: KeyAnswer;
    requestId: string;
    mine: { publicKey: string; privateKey: KeyObject };
  }> {
    const mine = handshakeKeyPair();
    const requestId = `mk-${randomUUID()}`;
    const body: MessageKeyRequestBody = {
      kind: MESSAGE_KEY_REQUEST,
      publicKey: mine.publicKey,
      partition: this.#partition,
      ts: Date.now(),
      nonce: randomUUID().replaceAll('-', ''),
    };
    const token = await this.#token();
    const url = await this.#url?.().catch(() => undefined);
    if (url) {
      const result = await this.#overHttps(url, token, requestId, body);
      if (result) {
        this.lastPath = 'https';
        return { result, requestId, mine };
      }
    }
    this.lastPath = 'broker';
    return { result: await this.#overBroker(token, requestId, body), requestId, mine };
  }

  /** The answer over HTTPS, or `undefined` when the route cannot be used (then the broker is). */
  async #overHttps(
    base: string,
    token: string,
    requestId: string,
    body: MessageKeyRequestBody,
  ): Promise<KeyAnswer | undefined> {
    const target = keyUrl(base);
    if (!target) return this.#httpsUnusable(`"${base}" is not a URL`);
    if (!usableKeyUrl(base)) return this.#httpsUnusable(`${target.origin} is not HTTPS`);
    try {
      const response = await this.#fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId, ...body }),
        signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 405) {
        return this.#httpsUnusable(
          `${target.origin} has no ${MESSAGE_KEY_PATH} (an older control plane?)`,
        );
      }
      const parsed = (await response.json()) as KeyAnswer;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
        return this.#httpsUnusable(`${target.origin} answered something else`);
      }
      return parsed;
    } catch (error) {
      return this.#httpsUnusable(
        `${target.origin} could not be reached (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  #httpsUnusable(why: string): undefined {
    if (this.#httpsWarned) return undefined;
    this.#httpsWarned = true;
    this.#log(
      'warn',
      `[${PACKAGE}] messages: asking the control plane for this pod's key over HTTPS failed: ${why}. Asking over the broker instead (the token then crosses it once).`,
    );
    return undefined;
  }

  async #overBroker(
    token: string,
    requestId: string,
    body: MessageKeyRequestBody,
  ): Promise<KeyAnswer> {
    const wire = this.#wire;
    if (!wire)
      throw new Error(
        `[${PACKAGE}] messages: the tenant key client is not attached to a transport`,
      );
    const answered = new Promise<RunReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('the control plane did not answer the message-key request in time'));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(requestId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
    answered.catch(() => undefined);
    await wire.dispatchRunRequest({
      requestId,
      tenant: token,
      body: body as unknown as RunRequest['body'],
    });
    return (await answered).result;
  }
}

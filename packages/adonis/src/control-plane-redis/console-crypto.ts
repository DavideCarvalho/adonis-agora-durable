import {
  CONSOLE_CRYPTO_KEY,
  type ConsoleCipher,
  type ConsoleTokenVerifier,
} from './console-auth.js';

/**
 * The automatic crypto mode of the federated console: when `@adonis-agora/crypto` is booted in the
 * same app and nothing else is configured, console commands are sealed with its `console-durable` key
 * with no line of config. `@adonis-agora/crypto` is never imported: its runtime is read structurally
 * from the container binding it publishes (`'agora.crypto'`).
 */

/** The part of `@adonis-agora/crypto`'s runtime (`'agora.crypto'`) the automatic mode uses. */
export interface CryptoRuntimeLike {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** This app's partition on the crypto server (its name on a standalone or control plane). */
  partition: string;
  /** Present where the crypto server is embedded in this app (standalone, control plane). */
  service?:
    | {
        encrypt(
          principal: CryptoPrincipalLike,
          input: { key: string; plaintext: string; aad?: string; context?: string },
        ): Promise<{ ciphertext: string }>;
        decrypt(
          principal: CryptoPrincipalLike,
          input: { key: string; ciphertext: string; aad?: string; context?: string },
        ): Promise<{ plaintext: string }>;
        createKey(
          principal: CryptoPrincipalLike,
          input: { name: string; type: string; description?: string },
        ): Promise<unknown>;
        store: { getKey(partition: string, name: string): Promise<unknown> };
        hmac?(
          principal: CryptoPrincipalLike,
          input: { key: string; message: string },
        ): Promise<{ hmac: string }>;
      }
    | undefined;
  /** This app's own operations (in-process on a server, over HTTP or a broker on a tenant). */
  operations: {
    /**
     * `partition` (a tenant of a crypto server only): seal with that app's key instead of this one's.
     * The server allows it for `encrypt` only, with the seal-only capability `crypto:seal:<key>`.
     */
    encrypt(input: {
      key: string;
      plaintext: string;
      aad?: string;
      context?: string;
      partition?: string;
    }): Promise<{ ciphertext: string }>;
    decrypt(input: {
      key: string;
      ciphertext: string;
      aad?: string;
      context?: string;
    }): Promise<{ plaintext: string }>;
    createKey?(input: { name: string; type: string; description?: string }): Promise<unknown>;
    /**
     * Whether `key` exists in this app's partition (and this app may use it): `false` when it is
     * missing. Not audited as an error, unlike the decrypt probe it replaces when present.
     */
    hasKey?(input: { key: string }): Promise<boolean>;
    /** HMAC-SHA256 under an `hmac-sha256` key (the durable control plane's message keys). */
    hmac?(input: { key: string; message: string }): Promise<{ hmac: string }>;
  };
}

/** Who a call to an embedded crypto service is made as. */
export interface CryptoPrincipalLike {
  partition: string;
  capabilities: string[];
  actor: string;
}

/** The package these lines name. */
const PACKAGE = '@adonis-agora/durable';

/** What the key-check block calls on this app's crypto. */
type CryptoOperationsLike = CryptoRuntimeLike['operations'];

/** Who the automatic mode acts as on an embedded crypto service (its audit rows say so). */
const ACTOR = 'durable:console';

/** The container the runtime is looked up in. */
interface ContainerLike {
  hasBinding(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

function isRuntime(value: unknown): value is CryptoRuntimeLike {
  const runtime = value as Partial<CryptoRuntimeLike> | null;
  return (
    !!runtime &&
    typeof runtime === 'object' &&
    typeof runtime.partition === 'string' &&
    typeof runtime.operations?.encrypt === 'function' &&
    typeof runtime.operations?.decrypt === 'function'
  );
}

/**
 * `@adonis-agora/crypto`'s runtime when it is booted in this app, else `undefined`. Never imports the
 * package: it is the `'agora.crypto'` container binding, checked by shape.
 */
export async function cryptoRuntimeOf(
  container: ContainerLike,
): Promise<CryptoRuntimeLike | undefined> {
  if (typeof container.hasBinding !== 'function' || !container.hasBinding('agora.crypto')) {
    return undefined;
  }
  const runtime = await container.make('agora.crypto');
  return isRuntime(runtime) ? runtime : undefined;
}

/**
 * Make sure `key` (an `aes256-gcm` key) exists in `partition` of an embedded crypto service. Idempotent:
 * a key that is there, or that another instance creates at the same time, is fine.
 */
export async function ensureConsoleKey(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<'exists' | 'created'> {
  if (await service.store.getKey(partition, key)) return 'exists';
  try {
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: ACTOR },
      {
        name: key,
        type: 'aes256-gcm',
        description: 'Seals the federated durable console commands (@adonis-agora/durable)',
      },
    );
    return 'created';
  } catch (error) {
    // Created meanwhile by another instance: what was wanted.
    if (await service.store.getKey(partition, key)) return 'exists';
    throw error;
  }
}

/** `fn` run once, again after a failure (a key creation that failed is retried on the next command). */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = fn();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/* ------------------------------------------------------------------------------------------- */
/* App side on a crypto tenant: is the console key there, and usable?                          */
/*                                                                                             */
/* Self-contained on purpose: every Agora lib ports this block as is (only PACKAGE and the     */
/* key default differ). Rules (SECURITY-UNIFORM-SPEC §10.7, §10.14):                           */
/* - ask `operations.hasKey({ key })` when crypto offers it (no audit noise); else probe with a */
/*   dummy decrypt, which an app may always do on its own console keys; never getKey (it needs */
/*   crypto:keys:read);                                                                        */
/* - only "not found" means missing: try to create it (servers with provisioning off), else     */
/*   one INFO line (the crypto server provisions console-* keys on the console's first seal);  */
/* - any other failure (forbidden, unauthenticated, server down) logs one WARN line: never     */
/*   silent, never a boot failure;                                                             */
/* - checked once at boot; after a warning, the next command's own decrypt is the retry (its  */
/*   error is classified the same way), so a command never makes two failing calls.          */
/* ------------------------------------------------------------------------------------------- */

/** What one decrypt failure says about the key. */
export type ConsoleKeyOutcome = 'missing' | 'usable' | 'refused' | 'unreachable';

/**
 * Classifies a decrypt error from @adonis-agora/crypto (its `CryptoError` / client error carry a
 * `code`; the message is the fallback for other clients). `usable`: the key exists and this app
 * may decrypt with it (only the dummy ciphertext was rejected).
 */
export function classifyConsoleKeyError(error: unknown): ConsoleKeyOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const text = errorText(error);
  if (code === 'not_found' || /no key named|not[ _]found/i.test(text)) return 'missing';
  if (code === 'invalid' || code === 'unreadable') return 'usable';
  if (
    code === 'forbidden' ||
    code === 'unauthenticated' ||
    /forbid|lacks|capabilit|denied|not allowed|unauthori[sz]ed|unauthenticated|\b40[13]\b/i.test(
      text,
    )
  ) {
    return 'refused';
  }
  if (
    /invalid|unreadable|malformed|ciphertext|unable to authenticate|auth(entication)? tag/i.test(
      text,
    )
  )
    return 'usable';
  return 'unreachable';
}

/** A `forbidden` refusal from crypto (its error code, or the message for other clients). */
export function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'forbidden' || /forbid/i.test(errorText(error));
}

/** The one line to log for `outcome`, or `undefined` when all is well. */
export function consoleKeyNote(
  runtime: Pick<CryptoRuntimeLike, 'partition'>,
  outcome: ConsoleKeyOutcome | 'created',
  key: string = CONSOLE_CRYPTO_KEY,
  detail?: string,
): { level: 'info' | 'warn'; line: string } | undefined {
  const where = `the crypto key "${key}" in partition ${runtime.partition}`;
  const create = `\`node ace crypto:keys:create ${key} --type aes256-gcm --application ${runtime.partition}\``;
  const why = detail ? ` (${detail})` : '';
  switch (outcome) {
    case 'usable':
      return undefined;
    case 'created':
      return { level: 'info', line: `[${PACKAGE}] console commands: created ${where}` };
    case 'missing':
      // Not a problem on a crypto tenant: the crypto server provisions `console-*` keys on the
      // console's first seal. Only a server with sealProvisioning off needs the command.
      return {
        level: 'info',
        line: `[${PACKAGE}] console commands: the crypto key "${key}" does not exist in partition ${runtime.partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${create.slice(1, -1)})`,
      };
    case 'refused':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: the crypto server refused this app on ${where}${why}; no grant is needed for an app's own console keys (crypto:decrypt:console-* is harmless if present): check this app's crypto token is valid and the crypto server is up to date`,
      };
    case 'unreachable':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: could not check ${where}${why}; is the crypto server up? Retried on the next command`,
      };
  }
}

/**
 * Checks the console key once (a dummy decrypt) and, when it is missing, tries to create it
 * through the channel crypto already configured (works with `crypto:keys:manage:console-*`).
 * Never throws: returns the line to log, or `undefined` when the key is there and usable.
 */
export async function checkTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  let outcome: ConsoleKeyOutcome;
  let detail: string | undefined;
  const hasKey = runtime.operations.hasKey;
  if (typeof hasKey === 'function') {
    // Newer crypto servers answer this directly: no decrypt, no error row in the audit. A
    // `forbidden` refusal is the "no permission" outcome; any other throw (an older server
    // without the route) falls back to the decrypt probe below.
    try {
      if (await hasKey.call(runtime.operations, { key })) return undefined;
      return createMissing(runtime, key);
    } catch (error) {
      if (isForbidden(error)) return consoleKeyNote(runtime, 'refused', key, errorText(error));
    }
  }
  try {
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return undefined; // a dummy that decrypts: cannot happen, but the key is clearly there
  } catch (error) {
    outcome = classifyConsoleKeyError(error);
    detail = errorText(error);
  }
  if (outcome !== 'missing') return consoleKeyNote(runtime, outcome, key, detail);
  return createMissing(runtime, key);
}

/** The key is missing: create it when this app may (servers with provisioning off), else say so. */
async function createMissing(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  try {
    if (typeof runtime.operations.createKey !== 'function') throw new Error('no createKey');
    await runtime.operations.createKey({
      name: key,
      type: 'aes256-gcm',
      description: `${PACKAGE}: seals the federated console's commands to this app`,
    });
    return consoleKeyNote(runtime, 'created', key);
  } catch {
    return consoleKeyNote(runtime, 'missing', key);
  }
}

/**
 * The tenant's console key, watched: `atBoot()` runs {@link checkTenantConsoleKey} once;
 * `decrypt` wraps the app's own decrypt so that, while the last check warned, a command's failure
 * is classified and logged (one line, only when it changes) and its success clears the warning.
 * No extra crypto call per command.
 */
export function watchTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  log: (note: { level: 'info' | 'warn'; line: string }) => void,
  key: string = CONSOLE_CRYPTO_KEY,
): { atBoot(): Promise<void>; decrypt: CryptoOperationsLike['decrypt'] } {
  let last: string | undefined;
  let healthy = false;
  const report = (note: { level: 'info' | 'warn'; line: string } | undefined) => {
    healthy = note === undefined || note.level === 'info';
    if (note && note.line !== last) log(note);
    last = note?.line;
  };
  const boot = once(async () => report(await checkTenantConsoleKey(runtime, key)));
  return {
    atBoot: () => boot().catch(() => undefined),
    decrypt: async (input) => {
      try {
        const result = await runtime.operations.decrypt(input);
        if (!healthy && input.key === key) report(undefined);
        return result;
      } catch (error) {
        if (input.key === key) {
          const outcome = classifyConsoleKeyError(error);
          // A command's ciphertext rejected for itself (tampered) says nothing about the key.
          if (outcome !== 'usable') report(consoleKeyNote(runtime, outcome, key, errorText(error)));
        }
        throw error;
      }
    },
  };
}

/** The one actionable line for a key the app could not confirm or create. */
export function missingKeyLine(
  partition: string,
  reason: string,
  key = CONSOLE_CRYPTO_KEY,
): string {
  return `[@adonis-agora/durable] console commands: could not confirm the crypto key ${key} in partition "${partition}" (${reason}). Create it on the crypto server: \`node ace crypto:keys:create ${key} --type aes256-gcm --application ${partition}\`, or grant this app's crypto client \`crypto:keys:manage:console-*\` so it creates it`;
}

/**
 * The app side's cipher (it opens the commands): its own crypto operations, in its own partition.
 * Where the crypto server is embedded here, the key is created on first use.
 */
export function appConsoleCipher(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
  log?: (level: 'info' | 'warn', line: string) => void,
  /** A crypto tenant's watched decrypt ({@link watchTenantConsoleKey}). */
  decrypt?: ConsoleCipher['decrypt'],
): () => Promise<ConsoleCipher> {
  const service = runtime.service;
  // Crypto embedded here: the key is created once (at boot, by the provider); a failure logs one
  // line, never fails the boot, and the next command tries again.
  const ready = service
    ? once(async () => {
        try {
          const state = await ensureConsoleKey(service, runtime.partition, key);
          if (state === 'created') {
            const note = consoleKeyNote(runtime, 'created', key);
            if (note) log?.(note.level, note.line);
          }
        } catch (error) {
          log?.('warn', missingKeyLine(runtime.partition, errorText(error), key));
          throw error;
        }
      })
    : async () => undefined;
  const cipher: ConsoleCipher = decrypt
    ? { encrypt: (input) => runtime.operations.encrypt(input), decrypt }
    : (runtime.operations as ConsoleCipher);
  return async () => {
    await ready().catch(() => undefined);
    return cipher;
  };
}

/**
 * The console side's cipher for the app of `partition` (the console seals with that app's key), an
 * encrypt-only wrapper:
 *
 * - crypto embedded in the console app (the Hub): its service, as a principal of `partition` allowed
 *   to `encrypt` with the key only; the key is created there when missing;
 * - the console app a tenant of a crypto server: the channel `config/crypto.ts` already configured,
 *   asking the server to encrypt with `partition`'s key (its token holds `crypto:seal:<key>`).
 */
export function consoleSideCipher(
  runtime: CryptoRuntimeLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): () => Promise<ConsoleCipher> {
  const service = runtime.service;
  const refuseDecrypt = async (): Promise<never> => {
    throw new Error('the console side never opens a console command');
  };
  if (!service) {
    const operations = runtime.operations;
    const cipher: ConsoleCipher = {
      async encrypt(input) {
        try {
          return await operations.encrypt({ ...input, partition });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `[@adonis-agora/durable] console commands: the crypto server refused to seal for "${partition}" (${reason}). Give this app's crypto client \`crypto:seal:console-*\`, upgrade @adonis-agora/crypto on the crypto server (sealing for another app needs a current one), or configure \`apps.<key>.controlPlane.crypto\` explicitly`,
          );
        }
      },
      decrypt: refuseDecrypt,
    };
    return async () => cipher;
  }
  const principal: CryptoPrincipalLike = {
    partition,
    capabilities: [`crypto:encrypt:${key}`],
    actor: ACTOR,
  };
  const cipher: ConsoleCipher = {
    encrypt: (input) => service.encrypt(principal, input),
    decrypt: refuseDecrypt,
  };
  return once(async () => {
    await ensureConsoleKey(service, partition, key);
    return cipher;
  });
}

/**
 * The doctor's deep check: seal a probe with `seal` (what the console encrypts with) and, when `open`
 * is given (what the app decrypts with), open it again. Throws when either is refused.
 */
export async function probeConsoleKey(
  seal: Pick<ConsoleCipher, 'encrypt'>,
  open: Pick<ConsoleCipher, 'decrypt'> | undefined,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<void> {
  const plaintext = 'agora:durable:console-probe';
  const aad = 'agora:durable:console-probe';
  const { ciphertext } = await seal.encrypt({ key, plaintext, aad, context: aad });
  if (!open) return;
  const opened = await open.decrypt({ key, ciphertext, aad, context: aad });
  if (opened.plaintext !== plaintext) throw new Error('the probe did not decrypt to itself');
}

/** A public OKP JWK, as authkit's key directory serves it (never a private `d`). */
export interface OkpJwkLike {
  kty: 'OKP';
  crv: string;
  x: string;
  kid?: string | undefined;
}

/** The purpose durable's console-command public key is published under in authkit's directory. */
export const CONSOLE_KEY_PURPOSE = 'console:durable';

/** The part of `@adonis-agora/authkit-client` (`'authkit.client'`) the automatic token mode uses. */
export interface AuthkitClientLike {
  /** Publishes one of this app's public keys to authkit's directory (background, never rejects). */
  publishAppKey?(input: { purpose: string; jwk: OkpJwkLike }): Promise<void>;
  /** Another app's public key for `purpose` from authkit's directory (cached), or `null`. */
  appKey?(input: { app: string; purpose: string }): Promise<OkpJwkLike | null>;
  /** Tokens for calls to another app (`aud = urn:agora:app:<target>`), when `service` is configured. */
  appCallTokens(): { token(app: string): Promise<string>; reset?(): void } | undefined | null;
  /** Verifies a token another app calls this one with, when `service` is configured. */
  appCallerVerifier():
    | {
        verifyToken(token: string): Promise<{
          app: string;
          capabilities: string[];
          clientId: string;
          expiresAt: number;
        } | null>;
      }
    | null
    | undefined;
}

function isAuthkitClient(value: unknown): value is AuthkitClientLike {
  const client = value as Partial<AuthkitClientLike> | null;
  return (
    !!client &&
    typeof client === 'object' &&
    (typeof client.appCallTokens === 'function' ||
      typeof client.appCallerVerifier === 'function' ||
      typeof client.publishAppKey === 'function' ||
      typeof client.appKey === 'function')
  );
}

/** `@adonis-agora/authkit-client` when it is booted in this app (`'authkit.client'`), by shape. */
export async function authkitClientOf(
  container: ContainerLike,
): Promise<AuthkitClientLike | undefined> {
  if (typeof container.hasBinding !== 'function' || !container.hasBinding('authkit.client')) {
    return undefined;
  }
  const client = await container.make('authkit.client');
  return isAuthkitClient(client) ? client : undefined;
}

/**
 * Console side: the app-call token source for the app `target` (its partition / name), or
 * `undefined` when authkit has no calls between apps configured. `reset()` drops the cached token
 * after the app refuses it.
 */
export function appCallTokenSource(
  client: AuthkitClientLike,
  target: string,
): (() => Promise<string>) | undefined {
  const tokens = typeof client.appCallTokens === 'function' ? client.appCallTokens() : undefined;
  if (!tokens || typeof tokens.token !== 'function') return undefined;
  const source = () => tokens.token(target);
  return Object.assign(source, { reset: () => tokens.reset?.() });
}

/**
 * App side: a {@link ConsoleTokenVerifier} for authkit app-call tokens, or `undefined` when authkit
 * has no calls between apps configured. The audience binds the token to this app, so it is marked
 * `appCall` (no partition rule); its capabilities are what authkit granted the calling app here.
 */
export function appCallVerifier(client: AuthkitClientLike): ConsoleTokenVerifier | undefined {
  const verifier =
    typeof client.appCallerVerifier === 'function' ? client.appCallerVerifier() : undefined;
  if (!verifier || typeof verifier.verifyToken !== 'function') return undefined;
  return async ({ token }) => {
    if (typeof token !== 'string' || token === '') return null;
    const caller = await verifier.verifyToken(token);
    if (!caller || typeof caller.app !== 'string') return null;
    return {
      partition: caller.app,
      capabilities: Array.isArray(caller.capabilities) ? caller.capabilities : [],
      clientId: caller.clientId,
      appCall: true,
    };
  };
}

/** Two verifiers as one: the first that accepts the token wins. */
export function eitherVerifier(
  first: ConsoleTokenVerifier,
  second: ConsoleTokenVerifier,
): ConsoleTokenVerifier {
  return async (request) => {
    let verified: Awaited<ReturnType<ConsoleTokenVerifier>> = null;
    try {
      verified = await first(request);
    } catch {
      verified = null;
    }
    return verified ?? second(request);
  };
}

/**
 * Console side: the app's console-command public key from authkit's key directory, or `undefined`
 * when the authkit client has no directory. Resolved per command (authkit caches it), so an app
 * that publishes its key later is found without a restart.
 */
export function directoryPublicKey(
  client: AuthkitClientLike,
  app: string,
): (() => Promise<string | null>) | undefined {
  if (typeof client.appKey !== 'function') return undefined;
  const lookup = client.appKey.bind(client);
  return async () => {
    const jwk = await lookup({ app, purpose: CONSOLE_KEY_PURPOSE }).catch(() => null);
    return jwk && jwk.kty === 'OKP' && jwk.crv === 'X25519' && typeof jwk.x === 'string'
      ? jwk.x
      : null;
  };
}

/** App side: publish this app's console-command public key (token mode) to authkit's directory. */
export function publishConsoleKey(
  client: AuthkitClientLike | undefined,
  publicKey: string,
): boolean {
  if (typeof client?.publishAppKey !== 'function') return false;
  void client
    .publishAppKey({
      purpose: CONSOLE_KEY_PURPOSE,
      jwk: { kty: 'OKP', crv: 'X25519', x: publicKey },
    })
    .catch(() => undefined);
  return true;
}

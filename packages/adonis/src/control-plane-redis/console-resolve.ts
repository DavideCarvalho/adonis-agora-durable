import {
  CONSOLE_CRYPTO_KEY,
  ConsoleChannelError,
  type ConsoleCommandAuthOptions,
  type ConsoleCryptoOptions,
  type ConsolePublicKeySource,
  type ConsoleSecret,
  type ConsoleTokenSource,
  type ConsoleTokenVerifier,
  consoleCommandPublicKey,
  consoleKeyId,
  TOKEN_UNAVAILABLE,
} from './console-auth.js';
import {
  type AuthkitClientLike,
  appCallTokenSource,
  appCallVerifier,
  appConsoleCipher,
  type CryptoRuntimeLike,
  consoleSideCipher,
  directoryPublicKey,
  eitherVerifier,
  watchTenantConsoleKey,
} from './console-crypto.js';

/**
 * How each side of the federated console resolves its authentication: what is configured explicitly
 * is used as given; otherwise the siblings booted in the same app are reused with no line of config
 * (`@adonis-agora/crypto` seals the commands, `@adonis-agora/authkit-client`'s calls between apps
 * carries a token). When nothing resolves, the caller fails the boot with {@link
 * AppConsoleResolution.error} / {@link ConsoleSideResolution.error}.
 */

const PACKAGE = '@adonis-agora/durable';

/** What the app side ended up with. */
export interface AppConsoleResolution {
  /** The authentication to answer with, or `undefined` when nothing resolved. */
  auth: ConsoleCommandAuthOptions | undefined;
  /** The modes, as the boot log line names them (`crypto (auto, key console-durable)`, …). */
  modes: string[];
  /** Set when no mode resolved: the boot error, naming every way out. */
  error?: string | undefined;
  /** Things worth one log line each (a token mode with no `APP_KEY`, …). */
  warnings: string[];
  /** The crypto runtime the automatic mode uses (for the key check and the doctor). */
  autoCrypto?: CryptoRuntimeLike | undefined;
  /** The automatic mode's key check, run once at boot (never throws, logs what it finds). */
  checkKey?: (() => Promise<void>) | undefined;
}

/** What the app side's `consoleCommands` says, normalized (`true` is `{}`). */
export interface AppConsoleInput {
  secret?: ConsoleSecret | undefined;
  /** An explicit cipher, `false` (no automatic crypto), or nothing (automatic when crypto is here). */
  crypto?: ConsoleCryptoOptions | false | undefined;
  /** The explicit verifier (resolved), `false` (no automatic token), or nothing. */
  verifyTenant?: ConsoleTokenVerifier | false | undefined;
  /** The control plane's own `verifyTenant` (resolved), the fallback on a control plane. */
  fallbackVerifier?: ConsoleTokenVerifier | undefined;
  /** The app's key, which token-mode commands are sealed to without crypto. */
  appKey?: ConsoleSecret | undefined;
  /** The control plane's prefix the command key pair is derived from (for the key's short id). */
  prefix?: string | undefined;
  /** `@adonis-agora/crypto`'s runtime, when booted here. */
  cryptoRuntime?: CryptoRuntimeLike | undefined;
  /** `@adonis-agora/authkit-client`, when booted here. */
  authkit?: AuthkitClientLike | undefined;
  /** Where the automatic crypto mode's key check says what it found (one line each time). */
  log?: ((level: 'info' | 'warn', line: string) => void) | undefined;
}

/** A console-commands configuration that cannot authenticate (thrown at boot, in the web process). */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

/** Where every boot error points. */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/durable/observability/federated-console#authenticating-the-console';

const DOCTOR_HINT = "Run `node ace agora:doctor` to see every Agora lib's console auth at once.";

/** The boot error of an app with `consoleCommands` and no way to authenticate them. */
export const APP_UNAUTHENTICATED = `[${PACKAGE}] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key ${CONSOLE_CRYPTO_KEY}), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it durable:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). ${DOCTOR_HINT} Docs: ${CONSOLE_AUTH_DOCS}`;

/** What else was found, after the uniform message (why the automatic modes did not apply). */
const notesOf = (notes: string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

/** {@link APP_UNAUTHENTICATED} with what explains it in this app (`crypto: false`, no APP_KEY). */
function appUnauthenticated(notes: string[]): string {
  return `${APP_UNAUTHENTICATED}${notesOf(notes)}`;
}

/** Resolve the app side: explicit options as given, else the siblings booted here. */
export function resolveAppConsoleAuth(input: AppConsoleInput): AppConsoleResolution {
  const modes: string[] = [];
  const warnings: string[] = [];
  const explicitCrypto = input.crypto !== undefined && input.crypto !== false;
  const explicitVerify = typeof input.verifyTenant === 'function';
  const explicit = input.secret !== undefined || explicitCrypto || explicitVerify;

  // The token verifier: the explicit one, else authkit's app-call tokens and the control plane's.
  let verifier: ConsoleTokenVerifier | undefined;
  let verifierLabel = '';
  if (explicitVerify) {
    verifier = input.verifyTenant as ConsoleTokenVerifier;
    verifierLabel = 'verifyTenant';
  } else if (input.verifyTenant !== false) {
    const appCalls = input.authkit ? appCallVerifier(input.authkit) : undefined;
    const fallback = input.fallbackVerifier;
    verifier = appCalls && fallback ? eitherVerifier(appCalls, fallback) : (appCalls ?? fallback);
    verifierLabel = [
      ...(appCalls ? ['authkit app-call, auto'] : []),
      ...(fallback ? ['control plane verifyTenant'] : []),
    ].join(' + ');
  }

  // Crypto: the explicit cipher, else the one of @adonis-agora/crypto booted here.
  let crypto: ConsoleCryptoOptions | undefined;
  let autoCrypto: CryptoRuntimeLike | undefined;
  let checkKey: (() => Promise<void>) | undefined;
  if (explicitCrypto) {
    const given = input.crypto as ConsoleCryptoOptions;
    crypto = { ...given, requireToken: given.requireToken ?? explicitVerify };
    modes.push(`crypto (key ${given.key ?? CONSOLE_CRYPTO_KEY})`);
  } else if (!explicit && input.crypto !== false && input.cryptoRuntime) {
    autoCrypto = input.cryptoRuntime;
    const runtime = autoCrypto;
    const log = input.log;
    // On a crypto tenant the key is watched: checked once at boot, and while that warned, each
    // command's own decrypt is the retry (one line per change, no extra call).
    const watch =
      !runtime.service && log
        ? watchTenantConsoleKey(runtime, (note) => log(note.level, note.line))
        : undefined;
    const cipher = appConsoleCipher(runtime, CONSOLE_CRYPTO_KEY, log, watch?.decrypt);
    crypto = { cipher, requireToken: false };
    checkKey = watch ? watch.atBoot : async () => void (await cipher());
    modes.push(`crypto (auto, key ${CONSOLE_CRYPTO_KEY})`);
  }

  // Token mode sealed to the key derived from APP_KEY: alongside crypto too (a migration path).
  const appKey = verifier ? input.appKey : undefined;
  if (verifier && crypto) {
    // Which crypto commands must carry a token: an explicit cipher with an explicit verifier
    // requires one; otherwise a token is checked when the command carries one.
    const required = crypto.requireToken !== false;
    const last = modes.pop() as string;
    modes.push(
      required
        ? `${last} + token required (${verifierLabel})`
        : `${last} + token checked when sent (${verifierLabel})`,
    );
  }
  if (verifier && appKey !== undefined) {
    const id = consoleKeyId(consoleCommandPublicKey(appKey, input.prefix ?? 'durable'));
    modes.push(`token (${verifierLabel}; sealed to ${id})`);
  }
  if (verifier && !crypto && appKey === undefined) {
    warnings.push(
      `[${PACKAGE}] consoleCommands: token mode (${verifierLabel}) needs an APP_KEY (commands are sealed to a key derived from it) or @adonis-agora/crypto; this app takes no token-mode command`,
    );
  }
  if (input.secret !== undefined) modes.push('secret');

  const auth: ConsoleCommandAuthOptions = {
    ...(input.secret !== undefined ? { secret: input.secret } : {}),
    ...(crypto ? { crypto } : {}),
    ...(verifier && (crypto || appKey !== undefined) ? { verifyTenant: verifier } : {}),
    ...(appKey !== undefined ? { appKey } : {}),
  };
  const answers = input.secret !== undefined || crypto !== undefined || appKey !== undefined;
  return {
    auth: answers ? auth : undefined,
    modes,
    warnings,
    ...(answers
      ? {}
      : {
          error: appUnauthenticated([
            ...(verifier && input.appKey === undefined
              ? [
                  `a token verifier is available (${verifierLabel}), but token mode needs an APP_KEY (commands are sealed to a key derived from it)`,
                ]
              : []),
            ...(input.crypto === false
              ? ['`crypto: false` turned the automatic crypto mode off']
              : []),
          ]),
        }),
    ...(autoCrypto ? { autoCrypto } : {}),
    ...(checkKey ? { checkKey } : {}),
  };
}

/** One configured app, as the console side reads it. */
export interface ConsoleSideEntry {
  secret?: ConsoleSecret | undefined;
  token?: ConsoleTokenSource | false | undefined;
  publicKey?: string | undefined;
  crypto?: ConsoleCryptoOptions | false | undefined;
  actions?: boolean | undefined;
}

/** What the console side ended up with for one app. */
export interface ConsoleSideResolution {
  auth: ConsoleCommandAuthOptions | undefined;
  modes: string[];
  /** Set when the entry may act but nothing resolved: the boot error. */
  error?: string | undefined;
  /** Whether the automatic crypto mode is used (for the doctor). */
  autoCrypto?: CryptoRuntimeLike | undefined;
}

/**
 * Resolve the console side for the app `id` whose crypto partition (and authkit app name) is
 * `partition`: explicit options as given, else the siblings booted in the console app.
 */
export function resolveConsoleSideAuth(
  id: string,
  partition: string,
  entry: ConsoleSideEntry,
  siblings: {
    crypto?: CryptoRuntimeLike | undefined;
    authkit?: AuthkitClientLike | undefined;
    /** Where the console side's runtime notes go (a token sent without, …): a warn line. */
    log?: ((line: string, level: 'info' | 'warn') => void) | undefined;
  },
): ConsoleSideResolution {
  const modes: string[] = [];
  const explicitCrypto = entry.crypto !== undefined && entry.crypto !== false;
  const explicitToken = entry.token !== undefined && entry.token !== false;
  const explicit = entry.secret !== undefined || explicitCrypto || explicitToken;

  let crypto: ConsoleCryptoOptions | undefined;
  let autoCrypto: CryptoRuntimeLike | undefined;
  if (explicitCrypto) {
    crypto = entry.crypto as ConsoleCryptoOptions;
    modes.push(`crypto (key ${crypto.key ?? CONSOLE_CRYPTO_KEY})`);
  } else if (!explicit && entry.crypto !== false && siblings.crypto) {
    autoCrypto = siblings.crypto;
    crypto = { cipher: consoleSideCipher(autoCrypto, partition) };
    modes.push(`crypto (auto, key ${CONSOLE_CRYPTO_KEY}, partition ${partition})`);
  }

  // §13a: crypto and authkit's key directory both here, nothing explicit: the app says how to reach
  // it. A key in the directory (it publishes one only in token mode) → token; else crypto. Decided
  // at the first command, cached, re-decided after 5 minutes or when the app does not answer.
  const appCalls =
    autoCrypto && entry.token !== false && entry.publicKey === undefined && siblings.authkit
      ? appCallTokenSource(siblings.authkit, partition)
      : undefined;
  const directoryKey =
    appCalls && siblings.authkit ? directoryPublicKey(siblings.authkit, partition) : undefined;
  if (crypto && autoCrypto && appCalls && directoryKey) {
    // One optional token for both: a failure warns once and holds minting back 5 minutes, whether
    // it was met choosing token mode or sending by crypto.
    const optional = optionalAppCallToken(appCalls, id, siblings.log);
    const cryptoAuth: ConsoleCommandAuthOptions = { crypto, token: optional, tokenOptional: true };
    const token = requiredAppCallToken(appCalls, id);
    return {
      auth: autoChooser(
        directoryKey,
        (publicKey) => ({ token, publicKey }),
        cryptoAuth,
        (reason) => optional.holdBack(reason),
      ),
      modes: [
        `auto (authkit key directory if the app publishes one, else crypto (auto, key ${CONSOLE_CRYPTO_KEY}, partition ${partition}))`,
      ],
      autoCrypto,
    };
  }

  // Without crypto, a token travels sealed to the app's public key: the configured one, else the one
  // the app published to authkit's key directory (looked up per command, never read from Redis).
  const directory =
    crypto === undefined && entry.publicKey === undefined && siblings.authkit
      ? directoryPublicKey(siblings.authkit, partition)
      : undefined;
  const publicKey: ConsolePublicKeySource | undefined = entry.publicKey ?? directory;
  const sealed = crypto !== undefined || publicKey !== undefined;
  let token: ConsoleTokenSource | undefined;
  if (explicitToken && !sealed) {
    const path = `durable_dashboard.apps["${id}"]`;
    return {
      auth: undefined,
      modes: [],
      error: `[${PACKAGE}] ${path}.controlPlane.token must travel sealed: set ${path}.controlPlane.publicKey (print it on that app with \`node ace durable:console-key\`), or boot @adonis-agora/authkit-client here (the app publishes its key to authkit's directory), or set ${path}.controlPlane.crypto`,
    };
  }
  // The token's label says how it travels: inside crypto, or sealed to the app's public key (its
  // short id, never the key; or authkit's key directory).
  // The key's source goes inside the parentheses. From the directory it is fetched by the first
  // command (never at boot: the app may boot later), so there is no id to show yet.
  const sealedTo = crypto
    ? ''
    : entry.publicKey !== undefined
      ? `; sealed to ${consoleKeyId(entry.publicKey)}`
      : directory
        ? '; sealed to the key the app publishes'
        : '';
  const source = crypto
    ? ''
    : entry.publicKey !== undefined
      ? ', controlPlane.publicKey'
      : directory
        ? ', authkit key directory'
        : '';
  if (explicitToken) {
    token = entry.token as ConsoleTokenSource;
    modes.push(`token (explicit${source}${sealedTo})`);
  } else if (entry.token !== false && entry.secret === undefined && siblings.authkit && sealed) {
    const calls = appCallTokenSource(siblings.authkit, partition);
    if (calls) {
      // §13b: in crypto mode the token is optional (a failing one never blocks the command); in
      // token mode it is required, and its failure says which grant to add.
      token = crypto
        ? optionalAppCallToken(calls, id, siblings.log)
        : requiredAppCallToken(calls, id);
      modes.push(`token (authkit app-call, auto${source}${sealedTo})`);
    }
  }
  if (entry.secret !== undefined) modes.push('secret');

  const canSend = entry.secret !== undefined || crypto !== undefined || token !== undefined;
  if (!canSend) {
    if (entry.actions === false) return { auth: undefined, modes: ['none (browse-only)'] };
    const path = `durable_dashboard.apps["${id}"]`;
    const notes = [
      ...(entry.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
      ...(entry.token === false ? ['`token: false` turned the automatic authkit token off'] : []),
      ...(siblings.authkit && !sealed && entry.token !== false
        ? [
            `authkit is here, but its token must travel sealed: set ${path}.controlPlane.publicKey from \`node ace durable:console-key\` on that app (or use an authkit-client with the key directory)`,
          ]
        : []),
    ];
    return {
      auth: undefined,
      modes: [],
      error: `[${PACKAGE}] ${path}: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${path}.controlPlane.secret, or ${path}.controlPlane.token — or actions: false to only browse it. ${DOCTOR_HINT}${notesOf(notes)}`,
    };
  }
  return {
    auth: {
      ...(entry.secret !== undefined ? { secret: entry.secret } : {}),
      ...(token !== undefined ? { token } : {}),
      ...(publicKey !== undefined && token !== undefined ? { publicKey } : {}),
      ...(crypto ? { crypto } : {}),
      ...(crypto && token !== undefined && !explicitToken ? { tokenOptional: true } : {}),
    },
    modes,
    ...(autoCrypto ? { autoCrypto } : {}),
  };
}

export { consoleKeyId };

/** How long a token-mint failure (or a mode decision) holds before it is tried again. */
const RETRY_MS = 5 * 60_000;

const grantHint = (app: string) =>
  `To attach it: grant the console's service client durable:console:* on "${app}" in authkit.`;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A token failure that only means the console's client has no grant on that app. */
const MISSING_GRANT = /invalid_target|not granted|no grant/i;

/** The OAuth error code a token failure carries, when it does (`invalid_target`). */
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

/** An optional app-call token that can also be held back by a failure met elsewhere (§13a). */
type OptionalAppCallToken = ConsoleTokenSource & {
  holdBack(reason: string, code?: unknown): void;
};

/**
 * §13b, crypto mode: the app-call token, optional. A failure (no grant, `invalid_target`, authkit
 * down) sends the command crypto-only, says so once per reason, and tries minting again after 5
 * minutes. `holdBack(reason)` does the same for a failure the required token met (§13a), so that
 * command makes no second failing mint.
 */
function optionalAppCallToken(
  calls: ConsoleTokenSource,
  app: string,
  log: ((line: string, level: 'info' | 'warn') => void) | undefined,
): OptionalAppCallToken {
  const get = calls as (() => Promise<string>) & { reset?(): void };
  let retryAt = 0;
  const warned = new Set<string>();
  const holdBack = (reason: string, code?: unknown): void => {
    retryAt = Date.now() + RETRY_MS;
    if (warned.has(reason)) return;
    if (warned.size < 100) warned.add(reason);
    try {
      // A missing grant may be the operator's choice (crypto is enough): info. Anything else
      // (authkit down, a broken client): warn. Same wording.
      log?.(
        `[${PACKAGE}] console commands to "${app}": sending without an authkit app-call token (crypto only): ${reason}. ${grantHint(app)}`,
        code === 'invalid_target' || MISSING_GRANT.test(reason) ? 'info' : 'warn',
      );
    } catch {
      // a logger that throws must not block the command
    }
  };
  const source = async (): Promise<string> => {
    if (Date.now() < retryAt) throw new Error('app-call token held back after a failure');
    try {
      return await get();
    } catch (error) {
      holdBack(reasonOf(error), codeOf(error));
      throw error;
    }
  };
  return Object.assign(source, { reset: () => get.reset?.(), holdBack });
}

/**
 * Token mode: the app-call token is required; its failure says which grant to add, with its own
 * code ({@link TOKEN_UNAVAILABLE}) so an automatic choice can send by crypto instead.
 */
function requiredAppCallToken(calls: ConsoleTokenSource, app: string): ConsoleTokenSource {
  const get = calls as (() => Promise<string>) & { reset?(): void };
  const source = async (): Promise<string> => {
    try {
      return await get();
    } catch (error) {
      const reason = reasonOf(error);
      throw new ConsoleChannelError(
        `authkit app-call token for "${app}" failed: ${reason}. ${grantHint(app)}`,
        TOKEN_UNAVAILABLE,
        reason,
      );
    }
  };
  return Object.assign(source, { reset: () => get.reset?.() });
}

/**
 * §13a: picks token mode when the app published its key to authkit's directory, else crypto — at
 * the first command, cached for 5 minutes, and decided again after a command that failed (an app
 * that refused the mode drops the command: a timeout). When token mode cannot mint its token,
 * crypto takes that command and the next ones for 5 minutes (§13b warning, once per reason).
 */
function autoChooser(
  directoryKey: () => Promise<string | null>,
  tokenAuth: (publicKey: string) => ConsoleCommandAuthOptions,
  cryptoAuth: ConsoleCommandAuthOptions,
  onTokenUnavailable: (reason: string) => void,
): ConsoleCommandAuthOptions {
  let decided: { auth: ConsoleCommandAuthOptions; at: number } | undefined;
  return {
    choose: async () => {
      if (decided && Date.now() - decided.at < RETRY_MS) return decided.auth;
      // The key the directory serves now is the one this decision seals to (until re-decided).
      const key = await directoryKey().catch(() => null);
      decided = { auth: key ? tokenAuth(key) : cryptoAuth, at: Date.now() };
      return decided.auth;
    },
    rechoose: () => {
      decided = undefined;
    },
    tokenUnavailable: (reason) => {
      // A stale key published by an older version of the app, or no grant: crypto, for a while.
      onTokenUnavailable(reason);
      decided = { auth: cryptoAuth, at: Date.now() };
      return cryptoAuth;
    },
  };
}

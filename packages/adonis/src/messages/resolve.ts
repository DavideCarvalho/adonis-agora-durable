import { type AppKey, appKeyOf } from '../app_key.js';
import { type CryptoRuntimeLike, cryptoRuntimeOf } from '../control-plane-redis/console-crypto.js';
import {
  type CryptoSealerSource,
  createMessageSealer,
  MESSAGES_CRYPTO_KEY,
  type MessageCipher,
  type MessageKind,
  type MessageSealer,
  type MessageSecret,
  onceReporter,
  type RejectionReporter,
} from './sealer.js';

const PACKAGE = '@adonis-agora/durable';
const DOCS = 'https://davidecarvalho.github.io/agora/docs/durable/transports/encrypting-messages';

/** A cipher, or a function returning one (`config/durable.ts` is read before crypto is ready). */
export type MessageCipherSource = MessageCipher | (() => MessageCipher | Promise<MessageCipher>);

/** `crypto` on a transport's `messages`: an `@adonis-agora/crypto` key, or your own KMS. */
export interface MessagesCryptoOptions {
  /** `encrypt` / `decrypt` of `@adonis-agora/crypto` (`() => crypto.client!`), or your own KMS. */
  cipher: MessageCipherSource;
  /** The key name. Default `durable-messages`. */
  key?: string | undefined;
  /** Whether a ciphertext is the key's. Default: it starts with `agora:ct1:<key>:`. */
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/**
 * How one transport (or the control plane) seals its messages: the same options as the other Agora
 * libs' channels. Keys are found automatically (the app's
 * `APP_KEY`; `@adonis-agora/crypto` between a tenant and its control plane); sending sealed is
 * `seal: true` (off by default in 1.x).
 */
export interface TransportMessagesOptions {
  /**
   * Seal what this transport sends. Default: `true` with an explicit `secret` / `crypto`, else the
   * top-level `messages.seal` of `config/durable.ts`, else `false` in 1.x: sent plain, so processes on 1.1 and earlier still read them, while sealed
   * messages are always opened (with the mode below). Turn it on once every process runs 1.2.1 or
   * later; it becomes the default in the next major.
   */
  seal?: boolean | undefined;
  /** Shared secret (16+ characters), the same in every process: HMAC-SHA256, readable on the broker. */
  secret?: MessageSecret | undefined;
  /**
   * Encrypt with an `@adonis-agora/crypto` key or your own KMS, for processes of several apps.
   * `false` turns the automatic mode off (plain messages, unless `secret` is set).
   */
  crypto?: MessagesCryptoOptions | false | undefined;
  /** Plain messages on this transport (local development; the wire of earlier versions). */
  insecure?: boolean | undefined;
  /**
   * With `seal: true`: accept plain messages too (jobs queued before sealing was turned on).
   * Default `true` in 1.x, logged once per process and kind; `false` refuses them. Without
   * `seal: true` plain messages are always accepted (the other processes send plain too).
   */
  acceptPlain?: boolean | undefined;
  /**
   * The app's key, for a transport built without AdonisJS (`new BullMQTransport(...)` in a thin
   * worker). Default `process.env.APP_KEY`. The AdonisJS transports read it from the app.
   */
  appKey?: MessageSecret | undefined;
}

interface AppLike {
  container?: { hasBinding?(binding: string): boolean; make(binding: string): Promise<unknown> };
  config?: { get?(key: string, fallback?: unknown): unknown };
}

export interface MessagesResolveContext {
  app?: AppLike | undefined;
  /** The transport's name in `config/durable.ts` (`bullmq`, `jobs`, …), for messages. */
  name: string;
  log?: ((level: 'info' | 'warn', line: string) => void) | undefined;
  /** The topology (default: `config/durable.ts`'s). */
  topology?: string | undefined;
}

/** The mode a transport resolves to, without building it (boot line, doctor). */
export type ResolvedMessagesMode =
  | { mode: 'plain'; label: string; why: 'insecure' | 'off' | 'no-key'; hint?: string }
  | { mode: 'app-key'; label: string }
  | { mode: 'secret'; label: string }
  | { mode: 'crypto'; label: string; auto: boolean };

function explicitModes(options: TransportMessagesOptions): number {
  return [
    options.secret !== undefined,
    options.crypto !== undefined && options.crypto !== false,
    options.insecure === true,
  ].filter(Boolean).length;
}

/** Why the automatic mode found no key, and what to add. */
export function noKeyHint(topology: string, cryptoWithoutService = false): string {
  const cross = topology === 'tenant' || topology === 'control-plane';
  const first = cross
    ? cryptoWithoutService
      ? "on a control plane the automatic mode needs @adonis-agora/crypto embedded in this app (it seals for each tenant's partition), and here crypto runs elsewhere"
      : `between a tenant and its control plane (topology '${topology}') the automatic mode needs @adonis-agora/crypto booted in this app (key ${MESSAGES_CRYPTO_KEY}, nothing else to configure)`
    : 'set APP_KEY in this app (automatic for the processes of one app; `node ace generate:key`)';
  return `${first}, or set \`messages: { secret }\` on the transport (a shared secret, at least 16 characters, the same in every process), or \`messages: { crypto: { cipher } }\` (@adonis-agora/crypto or your own KMS)`;
}

/** What {@link resolveMessageSealer} needs besides the options, read from the app. */
interface Inputs {
  topology: string;
  /** The top-level `messages` of `config/durable.ts`. */
  seal?: boolean | undefined;
  acceptPlain?: boolean | undefined;
  appKey: AppKey | undefined;
  runtime: CryptoRuntimeLike | undefined;
}

async function inputsOf(app: AppLike | undefined, topology?: string): Promise<Inputs> {
  let durable: Record<string, unknown> | undefined;
  try {
    durable = app?.config?.get?.('durable') as Record<string, unknown> | undefined;
  } catch {
    durable = undefined;
  }
  let runtime: CryptoRuntimeLike | undefined;
  try {
    runtime = app?.container?.hasBinding
      ? await cryptoRuntimeOf(app.container as Parameters<typeof cryptoRuntimeOf>[0])
      : undefined;
  } catch {
    runtime = undefined;
  }
  const top = durable?.messages as { seal?: unknown; acceptPlain?: unknown } | undefined;
  return {
    seal: typeof top?.seal === 'boolean' ? top.seal : undefined,
    acceptPlain: typeof top?.acceptPlain === 'boolean' ? top.acceptPlain : undefined,
    topology: topology ?? (typeof durable?.topology === 'string' ? durable.topology : 'standalone'),
    appKey: await appKeyOf(app),
    runtime,
  };
}

/** The mode `options` resolve to with `inputs` (throws only on several explicit modes). */
function decide(
  name: string,
  options: TransportMessagesOptions,
  inputs: Inputs,
): ResolvedMessagesMode {
  if (explicitModes(options) > 1) {
    throw new TypeError(
      `[${PACKAGE}] the ${name} transport's \`messages\` takes one of \`secret\`, \`crypto\` or \`insecure\`, not several`,
    );
  }
  if (options.insecure === true)
    return { mode: 'plain', label: 'plain (insecure)', why: 'insecure' };
  if (options.secret !== undefined) return { mode: 'secret', label: 'secret' };
  if (options.crypto !== undefined && options.crypto !== false) {
    return {
      mode: 'crypto',
      label: `crypto (key ${options.crypto.key ?? MESSAGES_CRYPTO_KEY})`,
      auto: false,
    };
  }
  if (options.crypto === false) {
    return { mode: 'plain', label: 'plain (crypto: false)', why: 'off' };
  }
  const cross = inputs.topology === 'tenant' || inputs.topology === 'control-plane';
  const appKey = options.appKey ?? inputs.appKey;
  if (!cross) {
    if (appKey === undefined) {
      return {
        mode: 'plain',
        label: 'plain (no APP_KEY)',
        why: 'no-key',
        hint: noKeyHint(inputs.topology),
      };
    }
    return { mode: 'app-key', label: 'app key (auto)' };
  }
  const runtime = inputs.runtime;
  if (!runtime) {
    return {
      mode: 'plain',
      label: 'plain (no @adonis-agora/crypto)',
      why: 'no-key',
      hint: noKeyHint(inputs.topology),
    };
  }
  if (inputs.topology === 'control-plane' && !runtime.service) {
    return {
      mode: 'plain',
      label: 'plain (crypto not embedded)',
      why: 'no-key',
      hint: noKeyHint(inputs.topology, true),
    };
  }
  return {
    mode: 'crypto',
    label: `crypto (auto, key ${MESSAGES_CRYPTO_KEY}, partition ${runtime.partition})`,
    auto: true,
  };
}

/** The resolved mode of a transport, without building it. */
export async function describeMessagesMode(
  app: AppLike | undefined,
  name: string,
  options: TransportMessagesOptions = {},
  topology?: string,
): Promise<
  (ResolvedMessagesMode & { sealing: boolean; acceptPlain: boolean }) | { error: string }
> {
  try {
    const inputs = await inputsOf(app, topology);
    const decided = decide(name, options, inputs);
    return {
      ...decided,
      sealing: decided.mode !== 'plain' && sealingOf(options, inputs),
      // Plain is always accepted while this transport does not seal (see `withSealing`).
      acceptPlain:
        decided.mode !== 'plain' && sealingOf(options, inputs)
          ? (options.acceptPlain ?? inputs.acceptPlain ?? true)
          : true,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

/** Make sure `key` exists in `partition` (crypto embedded here). */
async function ensureMessagesKey(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
  key: string,
): Promise<'exists' | 'created'> {
  if (await service.store.getKey(partition, key)) return 'exists';
  try {
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: 'durable:messages' },
      {
        name: key,
        type: 'aes256-gcm',
        description: `${PACKAGE}: seals the messages between this app and its control plane`,
      },
    );
    return 'created';
  } catch (error) {
    if (await service.store.getKey(partition, key)) return 'exists';
    throw error;
  }
}

/** The partition a control plane seals a message for (the tenant it goes to). */
function tenantPartitionOf(
  kind: MessageKind,
  msg: Record<string, unknown>,
  replies: Map<string, string>,
): string | undefined {
  if (kind === 'task' || kind === 'workflowTask') {
    const group = typeof msg.group === 'string' ? msg.group : '';
    const at = group.lastIndexOf('@');
    return at >= 0 ? group.slice(at + 1) : undefined;
  }
  if (kind === 'tenantEvent') return typeof msg.tenant === 'string' ? msg.tenant : undefined;
  if (kind === 'runReply') {
    return typeof msg.requestId === 'string' ? replies.get(msg.requestId) : undefined;
  }
  return undefined;
}

/** How many tenants' pending requests a control plane remembers the partition of. */
const REPLY_MEMO = 10_000;

/** The automatic crypto source: a tenant on its own partition, or a control plane for every tenant. */
function autoCryptoSource(
  runtime: CryptoRuntimeLike,
  topology: string,
  label: string,
  log: (level: 'info' | 'warn', line: string) => void,
): CryptoSealerSource {
  const key = MESSAGES_CRYPTO_KEY;
  const own = runtime.partition;
  const service = runtime.service;
  if (topology === 'tenant' || !service) {
    const cipher = runtime.operations as unknown as MessageCipher;
    return {
      key,
      label,
      cipherFor: async (partition) => {
        if (partition !== own) {
          throw new Error(`partition "${partition}" is not this app's (${own})`);
        }
        return cipher;
      },
      sealPartition: () => own,
      accepts: (partition) => partition === own,
    };
  }
  // Control plane with crypto embedded: seal and open in each tenant's partition.
  const ensured = new Map<string, () => Promise<void>>();
  const ready = (partition: string) => {
    let fn = ensured.get(partition);
    if (!fn) {
      fn = once(async () => {
        try {
          if ((await ensureMessagesKey(service, partition, key)) === 'created') {
            log(
              'info',
              `[${PACKAGE}] messages: created the crypto key "${key}" in partition ${partition}`,
            );
          }
        } catch (error) {
          log(
            'warn',
            `[${PACKAGE}] messages: could not create the crypto key "${key}" in partition ${partition} (${errorText(error)}). Create it: \`node ace crypto:keys:create ${key} --type aes256-gcm --application ${partition}\``,
          );
          throw error;
        }
      });
      ensured.set(partition, fn);
    }
    return fn();
  };
  const replies = new Map<string, string>();
  return {
    key,
    label,
    cipherFor: async (partition) => {
      await ready(partition).catch(() => undefined);
      const principal = {
        partition,
        capabilities: [`crypto:encrypt:${key}`, `crypto:decrypt:${key}`],
        actor: 'durable:messages',
      };
      return {
        encrypt: (input) => service.encrypt(principal, input),
        decrypt: (input) => service.decrypt(principal, input),
      };
    },
    sealPartition: (kind, msg) => tenantPartitionOf(kind, msg, replies) ?? own,
    accepts: (partition) => partition.length > 0,
    onOpened: (kind, msg, partition) => {
      // A reply goes back to the partition that asked.
      const id =
        kind === 'runRequest' ? msg.requestId : kind === 'startRun' ? msg.runId : undefined;
      if (typeof id !== 'string') return;
      if (replies.size >= REPLY_MEMO) {
        const oldest = replies.keys().next().value;
        if (oldest !== undefined) replies.delete(oldest);
      }
      replies.set(id, partition);
    },
  };
}

/** On a crypto tenant: is the messages key there? One line when it is not (never fails boot). */
async function checkTenantKey(
  runtime: CryptoRuntimeLike,
  log: (level: 'info' | 'warn', line: string) => void,
): Promise<void> {
  const key = MESSAGES_CRYPTO_KEY;
  const create = `node ace crypto:keys:create ${key} --type aes256-gcm --application ${runtime.partition}`;
  try {
    const has = runtime.operations.hasKey;
    if (typeof has === 'function') {
      if (await has.call(runtime.operations, { key })) return;
    } else {
      return; // an older crypto server: the first message tells
    }
  } catch (error) {
    log(
      'warn',
      `[${PACKAGE}] messages: could not check the crypto key "${key}" in partition ${runtime.partition} (${errorText(error)})`,
    );
    return;
  }
  try {
    if (typeof runtime.operations.createKey !== 'function') throw new Error('no createKey');
    await runtime.operations.createKey({
      name: key,
      type: 'aes256-gcm',
      description: `${PACKAGE}: seals the messages between this app and its control plane`,
    });
    log(
      'info',
      `[${PACKAGE}] messages: created the crypto key "${key}" in partition ${runtime.partition}`,
    );
  } catch {
    log(
      'warn',
      `[${PACKAGE}] messages: the crypto key "${key}" does not exist in partition ${runtime.partition}. Create it on the crypto server: \`${create}\`, or grant this app's crypto client \`crypto:keys:manage:${key}\` so it creates it`,
    );
  }
}

/** The cipher of an explicit `crypto` option, resolved on first use. */
function explicitCipher(source: MessageCipherSource): () => Promise<MessageCipher> {
  return async () => {
    const cipher = typeof source === 'function' ? await source() : source;
    if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
      throw new Error(
        `[${PACKAGE}] the messages \`crypto.cipher\` is not ready (is @adonis-agora/crypto booted?)`,
      );
    }
    return cipher;
  };
}

/**
 * What a plain transport opens sealed messages with: the mode it would resolve without
 * `insecure` / `crypto: false` (the app key, or crypto between apps), when it has one. So a process
 * kept plain during a rolling upgrade still reads what upgraded processes send.
 */
function fallbackOf(
  name: string,
  inputs: Inputs,
  options: TransportMessagesOptions,
  hooks: { report: RejectionReporter; log: (level: 'info' | 'warn', line: string) => void },
): MessageSealer | undefined {
  const { insecure: _insecure, crypto, ...rest } = options;
  const auto: TransportMessagesOptions = crypto === false ? rest : options;
  if (options.insecure !== true && crypto !== false) return undefined;
  let decided: ResolvedMessagesMode;
  try {
    decided = decide(name, { ...auto, insecure: undefined }, inputs);
  } catch {
    return undefined;
  }
  if (decided.mode === 'plain') return undefined;
  try {
    return buildSealer(decided, auto, inputs, {
      acceptPlain: true,
      report: hooks.report,
      onPlain: () => undefined,
      log: () => undefined,
    });
  } catch {
    return undefined;
  }
}

/**
 * Build the sealer of one transport from its `messages` options, the app's key and
 * `@adonis-agora/crypto` when it is booted, and log the mode once. Throws only on several explicit
 * modes; without a key the transport stays plain and says so (warning).
 */
export async function resolveMessageSealer(
  ctx: MessagesResolveContext,
  options: TransportMessagesOptions = {},
): Promise<MessageSealer> {
  const inputs = await inputsOf(ctx.app, ctx.topology);
  const decided = decide(ctx.name, options, inputs);
  const log =
    ctx.log ??
    ((level: 'info' | 'warn', line: string) =>
      level === 'warn' ? console.warn(line) : console.info(line));
  const report = onceReporter(ctx.name, (line) => log('warn', line));
  const plainSeen = plainNotice(ctx.name, (line) => log('warn', line));
  const { sealer, sealing, acceptPlain } = withSealing(decided, options, inputs, {
    report,
    onPlain: plainSeen,
    log,
  });
  const line = `[${PACKAGE}] ${ctx.name} messages: ${decided.label}`;
  const asked = sealingOf(options, inputs);
  if (decided.mode === 'plain') {
    // Plain because nothing seals: only worth a warning when sealing was asked for (or turned off by
    // hand); the 1.x default sends plain anyway.
    if (asked || decided.why !== 'no-key') {
      log(
        'warn',
        decided.why === 'no-key'
          ? `${line}: not sealed; ${decided.hint}. Docs: ${DOCS}`
          : `${line}: not sealed (anyone who can write to the broker can inject messages). Docs: ${DOCS}`,
      );
    }
  } else if (!sealing) {
    log(
      'info',
      `[${PACKAGE}] ${ctx.name} messages: sent plain, sealed ones opened with ${decided.label}. Once every process runs 1.2.1 or later, turn sealing on: \`messages: { seal: true }\` in config/durable.ts. Docs: ${DOCS}`,
    );
  } else {
    log('info', acceptPlain ? line : `${line}, plain messages refused`);
  }
  return sealer;
}

/** Whether a transport seals what it sends: its own `seal`, else the top-level one, else off. */
function sealingOf(options: TransportMessagesOptions, inputs: Inputs): boolean {
  // An explicit `secret` or `crypto` key is a deliberate choice (and sealed in 1.2.0): it seals
  // unless `seal: false` says otherwise.
  const explicit =
    options.secret !== undefined || (options.crypto !== undefined && options.crypto !== false);
  return options.seal ?? (explicit ? true : (inputs.seal ?? false));
}

/**
 * The sealer for `decided`, sending sealed only when sealing is on. Off (the 1.x default), it sends
 * plain and opens sealed messages with the resolved mode, and accepts every plain message.
 */
function withSealing(
  decided: ResolvedMessagesMode,
  options: TransportMessagesOptions,
  inputs: Inputs,
  hooks: {
    report: RejectionReporter;
    onPlain: (kind: MessageKind) => void;
    log: (level: 'info' | 'warn', line: string) => void;
  },
): { sealer: MessageSealer; sealing: boolean; acceptPlain: boolean } {
  const acceptPlain = options.acceptPlain ?? inputs.acceptPlain ?? true;
  if (decided.mode === 'plain') {
    return {
      sealer: buildSealer(decided, options, inputs, { ...hooks, acceptPlain: true }),
      sealing: false,
      acceptPlain: true,
    };
  }
  if (sealingOf(options, inputs)) {
    return {
      sealer: buildSealer(decided, options, inputs, { ...hooks, acceptPlain }),
      sealing: true,
      acceptPlain,
    };
  }
  const opener = buildSealer(decided, options, inputs, {
    ...hooks,
    acceptPlain: true,
    onPlain: () => undefined,
  });
  return {
    sealer: createMessageSealer(
      { mode: 'plain', label: `plain (opens ${decided.label})`, fallback: opener },
      { report: hooks.report },
    ),
    sealing: false,
    acceptPlain: true,
  };
}

function buildSealer(
  decided: ResolvedMessagesMode,
  options: TransportMessagesOptions,
  inputs: Inputs,
  hooks: {
    acceptPlain: boolean;
    report: RejectionReporter;
    onPlain: (kind: MessageKind) => void;
    log: (level: 'info' | 'warn', line: string) => void;
  },
): MessageSealer {
  const common = { acceptPlain: hooks.acceptPlain, report: hooks.report, onPlain: hooks.onPlain };
  switch (decided.mode) {
    case 'plain':
      return createMessageSealer(
        {
          mode: 'plain',
          label: decided.label,
          fallback: fallbackOf(decided.label, inputs, options, hooks),
        },
        { report: hooks.report },
      );
    case 'app-key':
      return createMessageSealer(
        { mode: 'app-key', appKey: (options.appKey ?? inputs.appKey) as AppKey },
        common,
      );
    case 'secret':
      return createMessageSealer(
        { mode: 'secret', secret: options.secret as MessageSecret },
        common,
      );
    case 'crypto': {
      let source: CryptoSealerSource;
      if (decided.auto) {
        const runtime = inputs.runtime as CryptoRuntimeLike;
        source = autoCryptoSource(runtime, inputs.topology, decided.label, hooks.log);
        if (inputs.topology === 'tenant') void checkTenantKey(runtime, hooks.log);
      } else {
        const crypto = options.crypto as MessagesCryptoOptions;
        const cipher = explicitCipher(crypto.cipher);
        source = {
          key: crypto.key ?? MESSAGES_CRYPTO_KEY,
          label: decided.label,
          owns: crypto.owns,
          cipherFor: () => cipher(),
          sealPartition: () => '',
          accepts: (partition) => partition === '',
        };
      }
      return createMessageSealer({ mode: 'crypto', source }, common);
    }
  }
}

/** Logs once per process and kind that a plain message was accepted. */
function plainNotice(name: string, warn: (line: string) => void): (kind: MessageKind) => void {
  const seen = new Set<MessageKind>();
  return (kind) => {
    if (seen.has(kind)) return;
    seen.add(kind);
    warn(
      `[${PACKAGE}] ${name} messages: accepted a plain ${kind} message (queued before this version, or sent by a process not upgraded yet). Set \`messages: { acceptPlain: false }\` to refuse them once none is left (the default of the next major). Docs: ${DOCS}`,
    );
  };
}

/**
 * The sealer of a transport built directly (`new BullMQTransport({ ..., messages })`, a thin worker
 * without AdonisJS): a ready {@link MessageSealer}, or the options (explicit modes, or `appKey`,
 * default `process.env.APP_KEY`). Without a key: plain.
 */
export function sealerOf(
  value: MessageSealer | TransportMessagesOptions | undefined,
  name: string,
): MessageSealer {
  if (value && typeof (value as MessageSealer).seal === 'function') return value as MessageSealer;
  const options = (value ?? {}) as TransportMessagesOptions;
  const envKey = process.env.APP_KEY;
  const inputs: Inputs = {
    topology: 'standalone',
    appKey: envKey !== undefined && envKey.length >= 16 ? envKey : undefined,
    runtime: undefined,
  };
  const decided = decide(name, options, inputs);
  const warn = (line: string) => console.warn(line);
  return withSealing(decided, options, inputs, {
    report: onceReporter(name, warn),
    onPlain: plainNotice(name, warn),
    log: (level, line) => (level === 'warn' ? console.warn(line) : console.info(line)),
  }).sealer;
}

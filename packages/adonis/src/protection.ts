import { CodecStateStore } from './codec-state-store.js';
import type { MessageMode } from './messages/sealer.js';

/**
 * What an app protects, as the console shows it: how each broker transport (and the Redis control
 * plane) seals its messages, and whether the state store encrypts payloads at rest. Names and modes
 * only: never a key, a secret, a key id, a token or a ciphertext.
 */
export interface AppProtection {
  /** One entry per broker transport (pool members included), then the control plane. Empty: none. */
  messages: MessagesProtection[];
  /** The state store this app writes through. Absent where the app has no store of its own. */
  store?: StoreProtection | undefined;
}

/** How one transport seals the messages it sends. */
export interface MessagesProtection {
  /** The transport's config key (`bullmq`), or `control plane`. */
  transport: string;
  /** `plain`: sent in the clear (also while sealing is not turned on yet). */
  mode: MessageMode;
  /** Whether plain messages are accepted (always in plain mode). */
  acceptPlain: boolean;
}

/** Whether the state store runs payloads through a codec (`CodecStateStore`), and which fields. */
export interface StoreProtection {
  codec: boolean;
  /** `payloads`: run/step `input` and `output`. `extended`: also `error`, step `events`, progress. */
  coverage: 'payloads' | 'extended' | null;
}

const MODES: ReadonlySet<string> = new Set<MessageMode>([
  'app-key',
  'secret',
  'crypto',
  'tenant-key',
  'plain',
]);

/**
 * Marks a store wrapper that encodes payloads like {@link CodecStateStore} (a host's own codec
 * decorator, or a wrapper around one): its value is the coverage, `'payloads'` or `'extended'`.
 */
export const AT_REST_COVERAGE: unique symbol = Symbol.for('@adonis-agora/durable.at-rest-coverage');

/** Whether `store` encrypts payloads at rest: a {@link CodecStateStore}, or a store marked so. */
export function storeProtectionOf(store: unknown): StoreProtection {
  if (store instanceof CodecStateStore) return { codec: true, coverage: store.coverage };
  if (store !== null && typeof store === 'object') {
    const marked = (store as { [AT_REST_COVERAGE]?: unknown })[AT_REST_COVERAGE];
    if (marked === 'payloads' || marked === 'extended') return { codec: true, coverage: marked };
  }
  return { codec: false, coverage: null };
}

/** The protection of a transport from its runtime sealer (`transport.messageSealer`). */
export function sealerProtection(
  transport: string,
  owner: unknown,
): MessagesProtection | undefined {
  if (owner === null || typeof owner !== 'object') return undefined;
  let sealer: unknown;
  try {
    sealer = (owner as { messageSealer?: unknown }).messageSealer;
  } catch {
    return undefined;
  }
  if (sealer === null || typeof sealer !== 'object') return undefined;
  const { mode, acceptsPlain } = sealer as { mode?: unknown; acceptsPlain?: unknown };
  if (typeof mode !== 'string' || !MODES.has(mode)) return undefined;
  return {
    transport,
    mode: mode as MessageMode,
    acceptPlain: mode === 'plain' ? true : acceptsPlain !== false,
  };
}

/**
 * `raw` reduced to the {@link AppProtection} fields, every other property dropped: what the console
 * keeps of an answer from another app (or anything else it did not build), so nothing but names
 * and modes reaches the page. `undefined` when `raw` is not one.
 */
export function sanitizeAppProtection(raw: unknown): AppProtection | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { messages, store } = raw as { messages?: unknown; store?: unknown };
  if (!Array.isArray(messages)) return undefined;
  const entries: MessagesProtection[] = [];
  for (const entry of messages.slice(0, 32)) {
    if (entry === null || typeof entry !== 'object') continue;
    const { transport, mode, acceptPlain } = entry as Record<string, unknown>;
    if (typeof transport !== 'string' || transport.length === 0 || transport.length > 64) continue;
    if (typeof mode !== 'string' || !MODES.has(mode)) continue;
    entries.push({ transport, mode: mode as MessageMode, acceptPlain: acceptPlain !== false });
  }
  const out: AppProtection = { messages: entries };
  if (store !== null && typeof store === 'object') {
    const { codec, coverage } = store as Record<string, unknown>;
    out.store =
      codec === true && (coverage === 'payloads' || coverage === 'extended')
        ? { codec: true, coverage }
        : { codec: false, coverage: null };
  }
  return out;
}

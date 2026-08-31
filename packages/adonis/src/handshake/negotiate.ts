/**
 * Bilateral compatibility negotiation between two handshake descriptors (design §7.3/§7.4). Pure
 * logic: given a local and a remote {@link WorkerDescriptor}, compute the negotiated session (highest
 * common protocol major + capability intersection) and classify it into one of three outcomes with a
 * precise, structured reason — never a bare boolean (design §7.6).
 */

import {
  normalizeDescriptor,
  type RawWorkerDescriptor,
  type WorkerDescriptor,
} from './descriptor.js';

/**
 * The three compatibility outcomes (design §7.4):
 * - `compatible`   — protocol ranges intersect + full capability parity → dispatch freely.
 * - `degraded`     — ranges intersect but a capability is missing on one side → dispatch, but route
 *                    capability-requiring work only to capable workers (soft warning).
 * - `incompatible` — no protocol-range overlap → do NOT dispatch; red flag with the exact reason.
 */
export type NegotiationOutcome = 'compatible' | 'degraded' | 'incompatible';

/** Structured failure/warning payload — carries the precise delta so a diagnostics event can render
 *  it on the timeline + dashboard health panel (design §7.6). Never a bare boolean. */
export interface NegotiationReason {
  /** Stable machine code for alerting/telescope. */
  code: 'protocol.incompatible' | 'capability.unavailable';
  /** Human-readable one-liner (dashboard/telescope copy). */
  message: string;
  /** The exact delta: which protocol ranges failed to overlap, or which capabilities are missing. */
  detail: {
    localRange?: [number, number];
    remoteRange?: [number, number];
    /** Capabilities the local side advertises that the remote lacks. */
    missingOnRemote?: string[];
    /** Capabilities the remote side advertises that the local lacks. */
    missingOnLocal?: string[];
    /** Explicitly-required capabilities not satisfied by the negotiated session. */
    missingRequired?: string[];
  };
}

/** The negotiated session + full delta between two sides. Carries both normalized descriptors so a
 *  downstream diagnostics event can attach them wholesale (design §7.6). */
export interface NegotiationResult {
  outcome: NegotiationOutcome;
  /** Highest common protocol major, or `null` when ranges do not overlap (incompatible). */
  negotiatedProtocol: number | null;
  protocol: { localRange: [number, number]; remoteRange: [number, number] };
  capabilities: {
    /** Intersection — the capabilities the negotiated session can rely on everywhere. */
    shared: string[];
    /** Local advertises, remote lacks. */
    missingOnRemote: string[];
    /** Remote advertises, local lacks. */
    missingOnLocal: string[];
  };
  /** Present for `degraded` + `incompatible`; absent for `compatible`. */
  reason?: NegotiationReason;
  local: WorkerDescriptor;
  remote: WorkerDescriptor;
}

export interface NegotiateOptions {
  /**
   * Capabilities the local side needs the negotiated session to provide. A required capability the
   * remote lacks degrades the session (dispatch generally, but capability-requiring runs park via
   * the router, design §7.5) — it never, on its own, makes the pair *incompatible*: only a protocol
   * range gap does that (design §7.4).
   */
  required?: string[];
}

const rangesOverlap = (a: [number, number], b: [number, number]): boolean =>
  Math.max(a[0], b[0]) <= Math.min(a[1], b[1]);

const difference = (a: string[], b: string[]): string[] => {
  const bset = new Set(b);
  return [...new Set(a)].filter((x) => !bset.has(x)).sort();
};

const intersection = (a: string[], b: string[]): string[] => {
  const bset = new Set(b);
  return [...new Set(a)].filter((x) => bset.has(x)).sort();
};

/**
 * Negotiate compatibility between `local` and `remote` (design §7.3/§7.4). Accepts raw/partial
 * descriptors (a missing `protocol`/`capabilities` is normalized to the legacy-v1 baseline, so a
 * legacy peer negotiates as **assume-compatible**, design §7.7).
 *
 * Outcome logic:
 * 1. no protocol-range overlap → `incompatible` (`protocol.incompatible`);
 * 2. else if a `required` capability is missing on the remote → `degraded` (`capability.unavailable`);
 * 3. else if the capability sets differ at all (either direction) → `degraded`;
 * 4. else full parity → `compatible`.
 *
 * **Bilateral-symmetric** on outcome for the parity path: `negotiate(a, b).outcome ===
 * negotiate(b, a).outcome` (the `missingOnLocal`/`missingOnRemote` delta swaps). `required` is the
 * caller's own need and intentionally asymmetric.
 */
export function negotiate(
  localRaw: RawWorkerDescriptor | WorkerDescriptor,
  remoteRaw: RawWorkerDescriptor | WorkerDescriptor,
  opts: NegotiateOptions = {},
): NegotiationResult {
  const local = normalizeDescriptor(localRaw);
  const remote = normalizeDescriptor(remoteRaw);
  const localRange = local.protocol.range;
  const remoteRange = remote.protocol.range;

  const shared = intersection(local.capabilities, remote.capabilities);
  const missingOnRemote = difference(local.capabilities, remote.capabilities);
  const missingOnLocal = difference(remote.capabilities, local.capabilities);
  const capabilities = { shared, missingOnRemote, missingOnLocal };

  // (1) Protocol range gap → incompatible. This is the ONLY path that blocks dispatch outright.
  if (!rangesOverlap(localRange, remoteRange)) {
    return {
      outcome: 'incompatible',
      negotiatedProtocol: null,
      protocol: { localRange, remoteRange },
      capabilities,
      reason: {
        code: 'protocol.incompatible',
        message:
          `no common protocol major: local speaks [${localRange[0]}, ${localRange[1]}], ` +
          `remote speaks [${remoteRange[0]}, ${remoteRange[1]}]`,
        detail: { localRange, remoteRange },
      },
      local,
      remote,
    };
  }

  const negotiatedProtocol = Math.min(localRange[1], remoteRange[1]);

  // (2) A required capability the remote cannot provide → degraded (router parks the specific run).
  const required = opts.required ?? [];
  const missingRequired = difference(required, remote.capabilities);
  if (missingRequired.length > 0) {
    return {
      outcome: 'degraded',
      negotiatedProtocol,
      protocol: { localRange, remoteRange },
      capabilities,
      reason: {
        code: 'capability.unavailable',
        message: `remote is missing required capability(ies): ${missingRequired.join(', ')}`,
        detail: { missingRequired, missingOnRemote, missingOnLocal },
      },
      local,
      remote,
    };
  }

  // (3) Any capability asymmetry → degraded (soft; route capability-requiring work carefully).
  if (missingOnRemote.length > 0 || missingOnLocal.length > 0) {
    const parts: string[] = [];
    if (missingOnRemote.length > 0) parts.push(`remote lacks ${missingOnRemote.join(', ')}`);
    if (missingOnLocal.length > 0) parts.push(`local lacks ${missingOnLocal.join(', ')}`);
    return {
      outcome: 'degraded',
      negotiatedProtocol,
      protocol: { localRange, remoteRange },
      capabilities,
      reason: {
        code: 'capability.unavailable',
        message: `capability mismatch: ${parts.join('; ')}`,
        detail: { missingOnRemote, missingOnLocal },
      },
      local,
      remote,
    };
  }

  // (4) Ranges overlap + full capability parity → compatible.
  return {
    outcome: 'compatible',
    negotiatedProtocol,
    protocol: { localRange, remoteRange },
    capabilities,
    local,
    remote,
  };
}

import type { NegotiationOutcome } from '../handshake/negotiate.js';

/**
 * Pure presentation helpers for the fleet-health panel, shared as the single source of truth between the
 * server-side `compat` handler and the dashboard's inline renderer (which mirrors these byte-for-byte).
 * Kept here — not inline in the HTML — so the mapping is unit-testable and can't silently drift.
 */

/** CSS class for a negotiation outcome's badge (`c-<outcome>`). */
export function outcomeClass(outcome: NegotiationOutcome): string {
  switch (outcome) {
    case 'compatible':
      return 'c-ok';
    case 'degraded':
      return 'c-degraded';
    case 'incompatible':
      return 'c-bad';
  }
}

/** Human label for a negotiation outcome (the badge text). */
export function outcomeLabel(outcome: NegotiationOutcome): string {
  switch (outcome) {
    case 'compatible':
      return 'compatible';
    case 'degraded':
      return 'degraded';
    case 'incompatible':
      return 'incompatible';
  }
}

/** Render a protocol band `[min, max]` compactly: `v1` for a single major, `v1–2` for a range. */
export function formatProtocolRange(range: [number, number]): string {
  return range[0] === range[1] ? `v${range[0]}` : `v${range[0]}–${range[1]}`;
}

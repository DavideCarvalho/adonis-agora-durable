import { Badge } from '../agora-kit/ui/badge';
import type { RunDisplayStatus, RunStatus, StepCheckpoint } from '../client/durable-client';

/** The durable brand mark — a workflow glyph: a rounded diamond with three connected nodes (a step
 *  flowing into the next), in currentColor so it inherits the `--accent` token. Replaces the bare `◆`. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="durable"
    >
      <title>durable</title>
      <path d="M12 2.5 21.5 12 12 21.5 2.5 12z" opacity={0.35} />
      <circle cx="6.4" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="17.6" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <path d="M8.1 12h2.2M13.7 12h2.2" />
    </svg>
  );
}

// The server's own `RUN_STATUSES` order (`run-filter.ts`), every state a chip.
export const STATUSES: RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'blocked',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'dead',
];

/** Runs fetched per `/runs` page — server caps `limit` at 200 (`handlers.ts`'s `listRuns`); this stays
 *  comfortably under that so a single page fetch is cheap, while still being large enough that most
 *  filtered views never need a second page. */
export const RUNS_PAGE_SIZE = 100;

export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function durMs(a: string, b: string): string {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function StatusDot({ status }: { status: RunDisplayStatus | StepCheckpoint['status'] }) {
  const live = status === 'running' || status === 'awaiting';
  return <span className={`dot s-${status} ${live ? 'pulse' : ''}`} aria-hidden />;
}

export function StatusBadge({ status }: { status: RunDisplayStatus | StepCheckpoint['status'] }) {
  return (
    <Badge variant="bare" className={`s-${status} gap-1.5 text-[11px]`}>
      <StatusDot status={status} />
      {status}
    </Badge>
  );
}

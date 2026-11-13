import { userInfo } from 'node:os';
import type { DashboardAuditEntry } from './define_config.js';

/** Where an audit line goes when the host configured no `audit` sink. */
export interface AuditLogger {
  info(message: string): void;
}

/**
 * Hand one console audit entry to the host's `audit` sink, or log the default
 * `[durable_dashboard] audit actor=… METHOD path` line. Shared by the console routes, the developer
 * tools and the ace commands, so every operator action lands in the same place. Never throws.
 */
export function recordConsoleAudit(
  sink: ((entry: DashboardAuditEntry) => void) | null | undefined,
  logger: () => Promise<AuditLogger>,
  entry: DashboardAuditEntry,
): void {
  try {
    if (sink) {
      // Typed `void`, but an async hook is assignable to it: catch its rejection too.
      const pending = sink(entry) as unknown;
      if (pending instanceof Promise) pending.catch(() => undefined);
      return;
    }
    void logger()
      .then((log) => {
        log.info(`[durable_dashboard] audit actor=${entry.actor} ${entry.method} ${entry.path}`);
      })
      .catch(() => undefined);
  } catch {
    /* auditing must never break the action */
  }
}

/** The actor an ace command records: `cli:<os user>`, or `cli` when the user cannot be read. */
export function cliActor(): string {
  try {
    const name = userInfo().username;
    return name ? `cli:${name}` : 'cli';
  } catch {
    return 'cli';
  }
}

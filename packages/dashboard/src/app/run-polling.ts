import type { RunDetail } from '../client/durable-client';
import { runFinished } from '../client/group-parallel-spans';

/** How often a child run's detail refreshes while the run can still move (the console's default). */
export const LIVE_RUN_POLL_MS = 2000;
/** How often it refreshes once the run has settled: a retry can still revive it, so not never. */
export const SETTLED_RUN_POLL_MS = 30_000;

/**
 * `refetchInterval` for the `['run', id]` queries a parent's graph, timeline and step panel open for
 * its child runs. A parent with dozens of finished children used to re-read every one of them every
 * 2s for as long as its page stayed open; a settled child now refreshes every 30s instead.
 */
export function childRunPollInterval(query: { state: { data: RunDetail | undefined } }): number {
  const status = query.state.data?.run?.status;
  return status !== undefined && runFinished(status) ? SETTLED_RUN_POLL_MS : LIVE_RUN_POLL_MS;
}

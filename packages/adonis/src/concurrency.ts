import { ConcurrencyLimitError } from './errors.js';
import type { RunQuery, RunStatus, StateStore } from './interfaces.js';

/**
 * A start-time concurrency quota for ONE start: at most `limit` runs sharing `key` may be in flight
 * (in `countStatuses`) at once; a start that would exceed it is rejected with
 * {@link ConcurrencyLimitError} before any run is created.
 *
 * The key is global — not per workflow — so different workflows started with the same key share the
 * quota (e.g. `tenant:acme` capping every kind of run a tenant can have executing). Passed per start
 * as `StartOptions.concurrency`, or derived from the input by a workflow's {@link ConcurrencyConfig}.
 */
export interface ConcurrencyQuota {
  /** The quota bucket, e.g. `tenant:acme`. Stamped on the run as the tag `concurrency:<key>`. */
  key: string;
  /** Max runs of this key in flight at once. `limit <= 0` rejects every start. */
  limit: number;
  /**
   * Which statuses occupy a slot. Default: every non-terminal status
   * ({@link DEFAULT_CONCURRENCY_STATUSES}). Narrow it to e.g. `['pending', 'running']` so runs parked
   * on a human (`suspended`) stop counting against the quota.
   */
  countStatuses?: RunStatus[] | undefined;
}

/**
 * A workflow's standing concurrency quota (`static workflow = { concurrency }` / `register(..., {
 * concurrency })`): the key is derived from each start's input, and the limit may be a function of
 * the key (per-tenant plans). A `StartOptions.concurrency` on one start overrides it.
 */
export interface ConcurrencyConfig {
  /** Derive the quota key from the input. Return `undefined` to leave this start unlimited. */
  key: (input: unknown) => string | undefined;
  /** Max in-flight runs per key — a number, or resolved per key (e.g. from the tenant's plan). */
  limit: number | ((key: string) => number | Promise<number>);
  /** Which statuses occupy a slot. See {@link ConcurrencyQuota.countStatuses}. */
  countStatuses?: RunStatus[] | undefined;
}

/** Every non-terminal status: what "in flight" means when a quota doesn't narrow it. */
export const DEFAULT_CONCURRENCY_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'blocked',
];

/** The tag a quota-bearing run carries, so its siblings can be counted by one tag+status query. */
export function concurrencyTag(key: string): string {
  return `concurrency:${key}`;
}

/** Resolve the quota that applies to one start: the per-start override, else the workflow's config. */
export async function resolveConcurrency(
  override: ConcurrencyQuota | undefined,
  config: ConcurrencyConfig | undefined,
  input: unknown,
): Promise<ConcurrencyQuota | undefined> {
  if (override) return override;
  if (!config) return undefined;
  const key = config.key(input);
  if (key === undefined) return undefined;
  const limit = typeof config.limit === 'function' ? await config.limit(key) : config.limit;
  return { key, limit, countStatuses: config.countStatuses };
}

/** Count the runs matching `query` as cheaply as the store allows (`countRuns`, else a listing). */
export async function countRuns(
  store: StateStore,
  query: Omit<RunQuery, 'page' | 'size'>,
): Promise<number> {
  if (store.countRuns) return store.countRuns(query);
  return (await store.listRuns(query)).length;
}

/**
 * Reject a start that would exceed `quota`: counts the in-flight runs carrying the quota's tag and
 * throws {@link ConcurrencyLimitError} once they reach the limit.
 *
 * A SOFT cap under a race: the count and the run's creation are separate statements, so N starts
 * racing on the last free slot can each see it free (the same guarantee a hand-rolled
 * `SELECT count(*)` gate gives). Exact whenever starts for a key are not simultaneous; the overshoot
 * is bounded by the number of truly concurrent starts. Use `singleton` for a strict, queueing
 * per-key limit instead of a rejecting one.
 */
export async function assertConcurrency(
  store: StateStore,
  workflow: string,
  quota: ConcurrencyQuota,
): Promise<void> {
  const active =
    quota.limit <= 0
      ? 0
      : await countRuns(store, {
          tag: concurrencyTag(quota.key),
          statuses: [...(quota.countStatuses ?? DEFAULT_CONCURRENCY_STATUSES)],
        });
  if (quota.limit <= 0 || active >= quota.limit) {
    throw new ConcurrencyLimitError(workflow, quota.key, quota.limit, active);
  }
}

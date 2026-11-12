import type { RunQuery, WorkflowRun } from '../index.js';
import { intersectTenantIds } from '../tenancy.js';
import type { DashboardEngine } from './handlers.js';

/**
 * Which tenants (organizations) the console shows a viewer, once tenancy is on:
 *
 * - `authorized`: what `authorize` granted — `'*'` (every tenant, and runs with no tenant), a list,
 *   or the viewer's own active tenant (`{ own }`), or nothing (`'none'`: a viewer with no tenant).
 * - `selected`: the tenant the viewer picked (`?tenant=`), already intersected with `authorized`.
 * - `ids`: what the API reads are confined to (`undefined` = no confinement).
 */
export interface ConsoleTenantScope {
  authorized: '*' | string[] | 'none';
  /** The viewer's own active tenant, when the scope came from it. */
  own?: { id: string; kind?: string | undefined; slug?: string | undefined } | undefined;
  selected: string | undefined;
  ids: Array<string | null> | undefined;
  /** The viewer asked for a tenant outside `authorized` (answered with nothing, and audited). */
  forged: boolean;
}

/** Resolve the console scope from the `authorize` grant, the viewer's tenant and their pick. */
export function resolveConsoleTenantScope(input: {
  granted: '*' | string[] | undefined;
  own: { id: string; kind?: string | undefined; slug?: string | undefined } | undefined;
  selected: string | undefined;
}): ConsoleTenantScope {
  const authorized: ConsoleTenantScope['authorized'] =
    input.granted !== undefined ? input.granted : input.own ? [input.own.id] : 'none';
  const selected = input.selected?.trim() || undefined;
  const pick = selected === '*' ? undefined : selected;
  const base = {
    authorized,
    ...(input.granted === undefined && input.own ? { own: input.own } : {}),
  };
  if (authorized === 'none')
    return { ...base, selected: undefined, ids: [], forged: pick !== undefined };
  if (pick === undefined) {
    return {
      ...base,
      selected: undefined,
      ids: authorized === '*' ? undefined : [...authorized],
      forged: false,
    };
  }
  if (authorized === '*' || authorized.includes(pick)) {
    return { ...base, selected: pick, ids: [pick], forged: false };
  }
  return { ...base, selected: pick, ids: [], forged: true };
}

function visible(ids: Array<string | null>, run: Pick<WorkflowRun, 'tenantId'> | null): boolean {
  return run !== null && ids.includes(run.tenantId ?? null);
}

/**
 * The console's read/control port confined to `ids`: listings carry `tenantIds`, a run outside the
 * scope reads as missing, and actions on it answer not-found. Every handler stays unchanged.
 */
export function scopedDashboardEngine(
  engine: DashboardEngine,
  ids: Array<string | null> | undefined,
  around?: <T>(fn: () => T) => T,
): DashboardEngine {
  const confined = ids === undefined ? engine : confine(engine, ids);
  if (around === undefined) return confined;
  // Every call runs as the console's own read (no app tenant applied on top of the console scope).
  const wrapped = { ...confined } as Record<string, unknown>;
  for (const [key, value] of Object.entries(confined)) {
    if (typeof value === 'function' && key !== 'subscribe') {
      wrapped[key] = (...args: unknown[]) =>
        around(() => (value as (...a: unknown[]) => unknown).apply(confined, args));
    }
  }
  return wrapped as unknown as DashboardEngine;
}

function confine(engine: DashboardEngine, ids: Array<string | null>): DashboardEngine {
  const narrow = <Q extends Pick<RunQuery, 'tenantIds'>>(query: Q): Q => ({
    ...query,
    tenantIds: intersectTenantIds(query.tenantIds, ids),
  });
  const sees = async (runId: string) => visible(ids, await engine.getRun(runId));
  const guard =
    <A extends unknown[], R>(fn: (runId: string, ...rest: A) => Promise<R>, hidden: R) =>
    async (runId: string, ...rest: A): Promise<R> =>
      (await sees(runId)) ? fn(runId, ...rest) : hidden;

  const scoped: DashboardEngine = {
    ...engine,
    getRun: async (runId) => {
      const run = await engine.getRun(runId);
      return visible(ids, run) ? run : null;
    },
    listRuns: (query) => engine.listRuns(narrow(query)),
    listCheckpoints: guard((id) => engine.listCheckpoints(id), []),
    getRunChildren: guard((id) => engine.getRunChildren(id), []),
    requeue: guard((id) => engine.requeue(id), null),
    redispatchPending: guard((id) => engine.redispatchPending(id), null),
    cancel: guard((id, opts?: { compensate?: boolean }) => engine.cancel(id, opts), null),
    retryWithInput: guard((id, input: unknown) => engine.retryWithInput(id, input), null),
    continue: guard((id) => engine.continue(id), null),
    subscribe: (runId, onEvent) => engine.subscribe(runId, onEvent),
    workerHealth: (extra) => engine.workerHealth(extra),
  };
  if (engine.getRunDetail) {
    const fn = engine.getRunDetail.bind(engine);
    scoped.getRunDetail = guard((id, options) => fn(id, options), null);
  }
  if (engine.getFanMembers) {
    const fn = engine.getFanMembers.bind(engine);
    scoped.getFanMembers = guard((id, group, query) => fn(id, group, query), null);
  }
  if (engine.update) {
    const fn = engine.update.bind(engine);
    scoped.update = guard((id, name: string, arg: unknown) => fn(id, name, arg), {
      accepted: false,
      reason: 'run not found',
    } as Awaited<ReturnType<NonNullable<DashboardEngine['update']>>>);
  }
  if (engine.completeTask) {
    const fn = engine.completeTask.bind(engine);
    scoped.completeTask = guard((id, name: string, result: unknown) => fn(id, name, result), null);
  }
  if (engine.failTask) {
    const fn = engine.failTask.bind(engine);
    scoped.failTask = guard((id, name: string, error: string) => fn(id, name, error), null);
  }
  if (engine.getEvent) {
    const fn = engine.getEvent.bind(engine);
    scoped.getEvent = guard((id, key: string) => fn(id, key), undefined);
  }
  if (engine.republishLifecycle) {
    const fn = engine.republishLifecycle.bind(engine);
    scoped.republishLifecycle = async (target) => {
      if ('runId' in target && !(await sees(target.runId))) {
        return { runs: 0, started: 0, failed: [] };
      }
      return fn(target);
    };
  }
  if (engine.countRuns) {
    const fn = engine.countRuns.bind(engine);
    scoped.countRuns = (query) => fn(narrow(query));
  }
  if (engine.runValueFacets) {
    const fn = engine.runValueFacets.bind(engine);
    scoped.runValueFacets = (axis, query, opts) => fn(axis, narrow(query), opts);
  }
  // Waiters name runs: only the scoped ones are listed, and a signal whose live waiter belongs to a
  // run outside the scope is not delivered (the console's routes check the run itself first).
  const waiterVisible = async (waiter: { runId: string }) => sees(waiter.runId);
  if (engine.listSignalWaiters) {
    const fn = engine.listSignalWaiters.bind(engine);
    scoped.listSignalWaiters = async (prefix) => {
      const out = [];
      for (const w of await fn(prefix)) if (await waiterVisible(w)) out.push(w);
      return out;
    };
  }
  if (engine.listSignalWaitersByRunIds) {
    const fn = engine.listSignalWaitersByRunIds.bind(engine);
    scoped.listSignalWaitersByRunIds = async (runIds) => {
      const mine: string[] = [];
      for (const id of runIds) if (await sees(id)) mine.push(id);
      return mine.length > 0 ? fn(mine) : [];
    };
  }
  if (engine.waitingFor) {
    const fn = engine.waitingFor.bind(engine);
    scoped.waitingFor = async (runIds) => {
      const mine: string[] = [];
      for (const id of runIds) if (await sees(id)) mine.push(id);
      return mine.length > 0 ? fn(mine) : {};
    };
  }
  if (engine.signal) {
    const fn = engine.signal.bind(engine);
    const listWaiters = engine.listSignalWaiters?.bind(engine);
    scoped.signal = async (token, payload) => {
      if (listWaiters) {
        for (const w of await listWaiters(token)) {
          if (w.token === token && !(await waiterVisible(w))) return null;
        }
      }
      // A webhook token names its run: `wh:<runId>:<seq>`.
      const webhook = /^wh:(.+):\d+$/.exec(token);
      if (webhook?.[1] !== undefined && !(await sees(webhook[1]))) return null;
      return fn(token, payload);
    };
  }
  return scoped;
}

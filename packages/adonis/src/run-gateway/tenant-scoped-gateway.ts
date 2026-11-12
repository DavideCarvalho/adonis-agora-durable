import { type EngineTenancy, intersectTenantIds, runVisible, tenantScopeIds } from '../tenancy.js';
import type { RunGateway, StartRunOptions } from './interface.js';

/**
 * A `tenant` pod's gateway with tenancy applied on the pod side: new runs carry the active tenant
 * (the control plane keeps it only when the pod's token grants `tenancy:*` or `tenancy:<id>`), and
 * the app's reads and actions see that tenant's runs only. Narrowing only: the control plane already
 * confines the pod to its partition.
 */
export function tenantScopedGateway(inner: RunGateway, tenancy: EngineTenancy): RunGateway {
  const visible = async (runId: string): Promise<boolean> => {
    const filter = tenancy.filter();
    if (filter.mode === 'system' || filter.mode === 'all') return true;
    const run = await inner.getRun(runId);
    return run === null || runVisible(filter, run, tenancy.nullRows);
  };
  const scoped = <Q extends { tenantIds?: Array<string | null> | undefined }>(query: Q): Q => {
    const ids = tenantScopeIds(tenancy.filter(), tenancy.nullRows);
    return ids === undefined
      ? query
      : { ...query, tenantIds: intersectTenantIds(query.tenantIds, ids) };
  };
  const guard =
    <A extends unknown[], R>(fn: (runId: string, ...rest: A) => Promise<R>, hidden: R) =>
    async (runId: string, ...rest: A): Promise<R> =>
      (await visible(runId)) ? fn(runId, ...rest) : hidden;

  const gateway: RunGateway = {
    topology: () => inner.topology(),
    getRun: async (runId) => {
      const run = await inner.getRun(runId);
      return run && runVisible(tenancy.filter(), run, tenancy.nullRows) ? run : null;
    },
    listRuns: (query) => inner.listRuns(scoped(query)),
    getCheckpoints: guard((id) => inner.getCheckpoints(id), []),
    getRunChildren: guard((id) => inner.getRunChildren(id), []),
    getSearchAttributes: guard((id) => inner.getSearchAttributes(id), undefined),
    workerHealth: () => inner.workerHealth(),
    start: (workflow, input, opts?: StartRunOptions) => {
      if (opts?.tenantId !== undefined) return inner.start(workflow, input, opts);
      const filter = tenancy.filter();
      if (filter.mode !== 'tenant') return inner.start(workflow, input, opts);
      return inner.start(workflow, input, {
        ...opts,
        tenantId: filter.tenant.id,
        ...(filter.tenant.kind ? { tenantKind: filter.tenant.kind } : {}),
      });
    },
    signal: guard(
      (id, signal: string, payload?: unknown) => inner.signal(id, signal, payload),
      null,
    ),
    cancel: guard((id, opts?: { compensate?: boolean }) => inner.cancel(id, opts), null),
    redispatchPending: guard((id) => inner.redispatchPending(id), null),
    subscribe: (runId, onEvent) => inner.subscribe(runId, onEvent),
  };
  if (inner.getRunDetail) {
    const fn = inner.getRunDetail.bind(inner);
    gateway.getRunDetail = guard((id, options) => fn(id, options), null);
  }
  if (inner.getFanMembers) {
    const fn = inner.getFanMembers.bind(inner);
    gateway.getFanMembers = guard((id, group, query) => fn(id, group, query), null);
  }
  if (inner.retry) {
    const fn = inner.retry.bind(inner);
    gateway.retry = guard((id) => fn(id), null);
  }
  if (inner.continue) {
    const fn = inner.continue.bind(inner);
    gateway.continue = guard((id) => fn(id), null);
  }
  if (inner.retryWithInput) {
    const fn = inner.retryWithInput.bind(inner);
    gateway.retryWithInput = guard((id, input) => fn(id, input), null);
  }
  if (inner.runFacets) {
    const fn = inner.runFacets.bind(inner);
    gateway.runFacets = (query) => fn(scoped(query));
  }
  if (inner.runValueFacets) {
    const fn = inner.runValueFacets.bind(inner);
    gateway.runValueFacets = (axis, query, opts) => fn(axis, scoped(query), opts);
  }
  if (inner.waitingFor) gateway.waitingFor = inner.waitingFor.bind(inner);
  if (inner.republishLifecycle) gateway.republishLifecycle = inner.republishLifecycle.bind(inner);
  if (inner.workflowLifecycle) gateway.workflowLifecycle = inner.workflowLifecycle.bind(inner);
  return gateway;
}

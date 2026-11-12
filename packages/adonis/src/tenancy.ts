import type { WorkflowRun } from './interfaces.js';

/**
 * Tenancy for durable: the customer (organization, clinic, …) a run's data belongs to. Off unless the
 * app turns it on, in `config/context.ts` (`tenancy.enabled`) with `@adonis-agora/context` installed,
 * or here with `tenancy: { enabled: true }`. The active tenant is read STRUCTURALLY from context's
 * global slot, so durable never imports context and works without it.
 */

/** A run's tenant: the id rows are stamped and compared by, and its kind when known. */
export interface RunTenant {
  id: string;
  kind?: string | undefined;
}

/** How an app-facing read or control call must scope runs right now. */
export type RunTenantFilter =
  /** No active context (workers, recovery, timers, ace): no filtering. */
  | { mode: 'system' }
  /** Inside an explicit all-tenants scope: every run, including runs with no tenant. */
  | { mode: 'all' }
  /** A context with no tenant: only runs with no tenant. */
  | { mode: 'tenantless' }
  /** A context with a tenant: only that tenant's runs. */
  | { mode: 'tenant'; tenant: RunTenant };

/** The `tenancy` option of `config/durable.ts`. */
export type DurableTenancyOption =
  | 'inherit'
  | false
  | {
      /** `'inherit'` (default) follows `tenancy.enabled` of `config/context.ts`. */
      enabled?: 'inherit' | boolean;
      /** Tenant kinds durable honours; another kind counts as no tenant. Defaults to context's `kinds`. */
      kinds?: string[];
      /**
       * What a tenant sees of runs started with no tenant: nothing (`'tenantless'`, default) or those
       * too (`'shared'`).
       */
      nullRows?: 'tenantless' | 'shared';
      /**
       * Route a tenant's runs to a worker pool of its own: return the namespace for a tenant, or
       * `undefined` for the default. Only for apps that run per-customer worker pools.
       */
      namespace?: (tenant: RunTenant) => string | undefined;
    };

/** What the engine asks about tenancy. Built by the provider; absent = tenancy off. */
export interface EngineTenancy {
  /** How to scope the current call. */
  filter(): RunTenantFilter;
  /** Run `fn` with `tenant` as the active tenant (a resumed turn, a dispatched task). */
  run<T>(tenant: RunTenant, fn: () => T): T;
  /** What a tenant sees of runs with no tenant. */
  nullRows: 'tenantless' | 'shared';
  /** The namespace for a tenant's new runs, when the app routes tenants to their own pools. */
  namespace?: ((tenant: RunTenant) => string | undefined) | undefined;
}

/** The run's tenant, or `undefined` when it has none. */
export function runTenantOf(
  run: Pick<WorkflowRun, 'tenantId' | 'tenantKind'>,
): RunTenant | undefined {
  if (run.tenantId === undefined || run.tenantId === null || run.tenantId === '') return undefined;
  return run.tenantKind ? { id: run.tenantId, kind: run.tenantKind } : { id: run.tenantId };
}

/** Whether `filter` lets the caller see `run` (the matching rule every Agora lib applies). */
export function runVisible(
  filter: RunTenantFilter,
  run: Pick<WorkflowRun, 'tenantId'>,
  nullRows: 'tenantless' | 'shared',
): boolean {
  if (filter.mode === 'system' || filter.mode === 'all') return true;
  const tenantId = run.tenantId ?? null;
  if (filter.mode === 'tenantless') return tenantId === null;
  if (tenantId === null) return nullRows === 'shared';
  return tenantId === filter.tenant.id;
}

/** The `tenantIds` a listing must be confined to under `filter`, or `undefined` for no confinement. */
export function tenantScopeIds(
  filter: RunTenantFilter,
  nullRows: 'tenantless' | 'shared',
): Array<string | null> | undefined {
  if (filter.mode === 'system' || filter.mode === 'all') return undefined;
  if (filter.mode === 'tenantless') return [null];
  return nullRows === 'shared' ? [filter.tenant.id, null] : [filter.tenant.id];
}

/** Intersect two tenant scopes (`undefined` = unrestricted). */
export function intersectTenantIds(
  a: Array<string | null> | undefined,
  b: Array<string | null> | undefined,
): Array<string | null> | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a.filter((id) => b.includes(id));
}

// ── the structural reader of @adonis-agora/context's tenancy slot ─────────────────────────────────

const CONTEXT_TENANCY = Symbol.for('@agora/context:tenancy');

interface TenancySlotLike {
  version: number;
  tenancy(): { enabled: boolean; kinds?: string[] };
  tenantFilter(options?: {
    kinds?: string[];
  }):
    | { mode: 'system' | 'all' | 'tenantless' }
    | { mode: 'tenant'; tenant: { id: string; kind?: string } };
  withTenant<T>(input: { id: string; kind: string; source?: string } | null, fn: () => T): T;
  allTenants<T>(fn: () => T): T;
  tenantLabels?(ids: string[], kind?: string): Promise<Record<string, string>>;
}

/** Context's tenancy slot, when installed and of a version durable reads. */
export function tenancySlot(): TenancySlotLike | undefined {
  const slot = (globalThis as Record<symbol, unknown>)[CONTEXT_TENANCY] as
    | Partial<TenancySlotLike>
    | undefined;
  if (slot?.version !== 1) return undefined;
  if (typeof slot.tenantFilter !== 'function' || typeof slot.withTenant !== 'function') {
    return undefined;
  }
  return slot as TenancySlotLike;
}

/** Whether tenancy is on for durable under `option` (reads context for `'inherit'`). */
export function tenancyEnabled(option: DurableTenancyOption | undefined): boolean {
  if (option === false) return false;
  const slot = tenancySlot();
  if (slot === undefined) return false;
  const enabled = typeof option === 'object' ? (option.enabled ?? 'inherit') : 'inherit';
  if (enabled === 'inherit') return slot.tenancy().enabled === true;
  return enabled;
}

/**
 * The engine's tenancy, read from context's slot, or `undefined` when tenancy is off (option
 * `false`, context not installed, or not enabled). Re-evaluates the switch on every call so a
 * context provider that boots after durable is still honoured.
 */
export function contextEngineTenancy(
  option: DurableTenancyOption | undefined,
): EngineTenancy | undefined {
  if (option === false) return undefined;
  const config = typeof option === 'object' ? option : {};
  return {
    nullRows: config.nullRows ?? 'tenantless',
    ...(config.namespace ? { namespace: config.namespace } : {}),
    filter(): RunTenantFilter {
      const slot = tenancySlot();
      if (slot === undefined || !tenancyEnabled(option)) return { mode: 'system' };
      const filter = slot.tenantFilter(config.kinds ? { kinds: config.kinds } : undefined);
      if (filter.mode === 'tenant') {
        const tenant = (filter as { tenant: { id: string; kind?: string } }).tenant;
        return {
          mode: 'tenant',
          tenant: tenant.kind ? { id: tenant.id, kind: tenant.kind } : { id: tenant.id },
        };
      }
      return { mode: filter.mode };
    },
    run<T>(tenant: RunTenant, fn: () => T): T {
      const slot = tenancySlot();
      if (slot === undefined || !tenancyEnabled(option)) return fn();
      return slot.withTenant(
        { id: tenant.id, kind: tenant.kind ?? 'unknown', source: 'carrier' },
        fn,
      );
    },
  };
}

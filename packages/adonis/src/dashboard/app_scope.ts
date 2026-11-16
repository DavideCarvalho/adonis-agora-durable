import type { RunQuery, WorkflowRun } from '../interfaces.js';
import { namespaceMatches } from '../namespaces.js';
import type { DashboardEngine } from './handlers.js';
import { confineEngine } from './tenant_scope.js';

/**
 * The apps a console viewer may see on a control plane, from `authorize`'s `apps` grant (the same
 * shape every Agora console takes): a tenant app's runs live in its partition (`run.namespace`), its
 * workers in `<name>@<app>` groups. `'*'` or an omitted grant is every app; a list confines the
 * console (listings, counts, facets, run reads, every action, schedules, worker health) to those
 * apps. The control plane's own runs (the `'default'` namespace) are only seen with `'*'`.
 */
export type ConsoleAppGrant = '*' | string[] | undefined;

/** The apps of a grant that confines, or `undefined` for every app. */
export function grantedApps(grant: ConsoleAppGrant): string[] | undefined {
  return grant === undefined || grant === '*' ? undefined : grant;
}

/** `query` narrowed to `apps`: its own namespace filter kept only where it is one of them. */
export function narrowToApps<Q extends Pick<RunQuery, 'namespace' | 'namespaces'>>(
  query: Q,
  apps: readonly string[],
): Q {
  const inApps = (ns: string) => apps.some((app) => namespaceMatches(ns, app));
  const { namespace, namespaces, ...rest } = query;
  let allowed: string[] = [...apps];
  if (namespace !== undefined) allowed = inApps(namespace) ? [namespace] : [];
  if (namespaces !== undefined)
    allowed = allowed.filter((a) => namespaces.some((n) => namespaceMatches(n, a)));
  // An empty `namespaces` matches nothing.
  return { ...rest, namespaces: allowed } as unknown as Q;
}

/** Whether `run` belongs to one of `apps`. */
export function runInApps(
  run: Pick<WorkflowRun, 'namespace'> | null,
  apps: readonly string[],
): boolean {
  return run !== null && apps.some((app) => namespaceMatches(run.namespace, app));
}

/** The console's read/control port confined to `apps` (see {@link ConsoleAppGrant}). */
export function appScopedDashboardEngine(
  engine: DashboardEngine,
  apps: readonly string[],
): DashboardEngine {
  const scoped = confineEngine(engine, {
    narrow: (query) => narrowToApps(query, apps),
    visible: (run) => runInApps(run, apps),
    groups: (group) => apps.some((app) => group.endsWith(`@${app}`)),
  });
  // Schedules are pinned to a namespace: one outside the apps is neither listed nor controllable.
  const listSchedules = engine.listSchedules?.bind(engine);
  if (listSchedules) {
    const own = async () =>
      (await listSchedules()).filter((s) => s.namespace !== undefined && runInApps(s, apps));
    scoped.listSchedules = own;
    const mine = async (key: string) => (await own()).some((s) => s.key === key);
    const setPaused = engine.setSchedulePaused?.bind(engine);
    if (setPaused) {
      scoped.setSchedulePaused = async (key, paused) =>
        (await mine(key)) ? setPaused(key, paused) : false;
    }
    const trigger = engine.triggerSchedule?.bind(engine);
    if (trigger) {
      scoped.triggerSchedule = async (key) => ((await mine(key)) ? trigger(key) : null);
    }
  } else {
    delete scoped.setSchedulePaused;
    delete scoped.triggerSchedule;
  }
  return scoped;
}

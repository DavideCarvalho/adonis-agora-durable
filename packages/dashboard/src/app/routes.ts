import { workflowFromHash, workflowHash } from './WorkflowLifecycle';

/**
 * The console's pages, all in the URL hash so each is deep-linkable and survives a reload:
 * `#/run/<id>` (the runs board with a run open), `#/workflow/<name>`, `#/workers`, `#/schedules`;
 * no hash is the runs board. The hash stays the run deep link it has always been (search hits and
 * other consoles link `<mount>#/run/<id>`).
 */
export type Route =
  | { page: 'runs'; runId?: string }
  | { page: 'workers' }
  | { page: 'schedules' }
  | { page: 'workflow'; workflow: string };

export function parseRoute(hash: string): Route {
  const run = hash.match(/^#\/run\/(.+)$/)?.[1];
  if (run) return { page: 'runs', runId: decodeURIComponent(run) };
  const workflow = workflowFromHash(hash);
  if (workflow !== undefined) return { page: 'workflow', workflow };
  if (hash === '#/workers') return { page: 'workers' };
  if (hash === '#/schedules') return { page: 'schedules' };
  return { page: 'runs' };
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case 'runs':
      return route.runId ? `#/run/${encodeURIComponent(route.runId)}` : '';
    case 'workflow':
      return workflowHash(route.workflow);
    default:
      return `#/${route.page}`;
  }
}

export function currentRoute(): Route {
  return typeof window === 'undefined' ? { page: 'runs' } : parseRoute(window.location.hash);
}

/** Push `route` onto history (no-op when it is already the current URL). */
export function pushRoute(route: Route): void {
  if (typeof window === 'undefined') return;
  const hash = routeHash(route);
  if (window.location.hash === hash) return;
  const url = hash || window.location.pathname + window.location.search;
  window.history.pushState(null, '', url);
}

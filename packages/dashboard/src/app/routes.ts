import { joinHash, splitHash } from '../agora-kit/url-state/hash-url';
import { workflowFromHash, workflowHash } from './WorkflowLifecycle';

/**
 * The console's pages, all in the URL hash so each is deep-linkable and survives a reload:
 * `#/run/<id>` (the runs board with a run open), `#/workflow/<name>`, `#/workers`, `#/schedules`;
 * no hash is the runs board. The hash stays the run deep link it has always been (search hits and
 * other consoles link `<mount>#/run/<id>`).
 *
 * The runs board's filters ride in the hash's query (`#/run/<id>?status=failed&tag=vip`, through
 * the kit's `NuqsHashAdapter`); the route is decided by the path half only.
 */
export type Route =
  | { page: 'runs'; runId?: string }
  | { page: 'workers' }
  | { page: 'schedules' }
  | { page: 'workflow'; workflow: string };

export function parseRoute(hash: string): Route {
  const { path } = splitHash(hash);
  const pathHash = `#${path}`;
  const run = pathHash.match(/^#\/run\/(.+)$/)?.[1];
  if (run) return { page: 'runs', runId: decodeURIComponent(run) };
  const workflow = workflowFromHash(pathHash);
  if (workflow !== undefined) return { page: 'workflow', workflow };
  if (path === '/workers') return { page: 'workers' };
  if (path === '/schedules') return { page: 'schedules' };
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

/** Whether two routes name the same page (and the same run / workflow). */
export function sameRoute(a: Route, b: Route): boolean {
  return routeHash(a) === routeHash(b);
}

export function currentRoute(): Route {
  return typeof window === 'undefined' ? { page: 'runs' } : parseRoute(window.location.hash);
}

/**
 * Push `route` onto history (no-op when it is already the current URL). `search` is the hash query
 * to carry along: the runs board's filters, kept when a run is opened or closed.
 */
export function pushRoute(route: Route, search = ''): void {
  if (typeof window === 'undefined') return;
  const path = routeHash(route).replace(/^#/, '');
  const hash = path === '' && search === '' ? '' : joinHash(path, search);
  if (window.location.hash === hash) return;
  const url = hash || window.location.pathname + window.location.search;
  window.history.pushState(null, '', url);
  // `pushState` fires nothing: tell the URL's subscribers (the filters' nuqs adapter, the App's
  // route) the hash moved, as back/forward would.
  window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
}

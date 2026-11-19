import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import {
  AppModeBadge,
  actionsUnavailableReason,
  FederatedNotice,
} from '../agora-kit/blocks/app-mode';
import { ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { subscribeHashUrl } from '../agora-kit/url-state/hash-url';
import { type AppPicker, durableClient, selectedApp } from '../client/durable-client';
import { currentRoute, routeHash } from './routes';

/**
 * Put the picked app in the URL (`?app=`, absent = this app). The runs board's filters and an open
 * run belong to the app being left, so the page stays but its hash query and run are dropped.
 */
export function writeAppToUrl(app: string | undefined): void {
  const url = new URL(window.location.href);
  if (app === undefined) url.searchParams.delete('app');
  else url.searchParams.set('app', app);
  const route = currentRoute();
  url.hash = routeHash(route.page === 'runs' ? { page: 'runs' } : route);
  window.history.pushState(null, '', url.toString());
  // A pushState fires nothing: tell the router and the URL-state adapter the URL moved.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The selector's data: this app plus the other apps the console shows. */
export function useAppPicker(): AppPicker | undefined {
  const { data } = useQuery({
    queryKey: ['apps'],
    queryFn: () => durableClient.apps(),
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });
  return data;
}

/** The picked other app (`?app=`) as `/apps` lists it, or undefined for this app / an older server. */
function usePickedApp(): AppPicker['apps'][number] | undefined {
  const picker = useAppPicker();
  const current = selectedApp();
  if (current === undefined || !picker || !Array.isArray(picker.apps)) return undefined;
  return picker.apps.find((a) => a.id === current);
}

/**
 * Why actions (retry, cancel, signal, schedule control…) are unavailable for the picked app, or
 * undefined when they are: a federated app this console only browses (`actions: 'none'`).
 */
export function useAppActionsUnavailable(): string | undefined {
  const app = usePickedApp();
  return app ? actionsUnavailableReason(app.label, app) : undefined;
}

/** The strip at the top of every page while a federated app is picked: whose data, who acts. */
export function FederatedAppNotice({ className }: { className?: string | undefined }) {
  const app = usePickedApp();
  if (!app) return null;
  return (
    <FederatedNotice
      appLabel={app.label}
      mode={app.mode}
      actions={app.actions}
      className={className}
    />
  );
}

const APP_TEXT = {
  noun: 'App',
  all: 'This app',
  some: 'This app',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The page's query string, kept current: the pickers write `?app=` / `?tenant=` with `pushState`
 * plus a `popstate`, which re-renders them with the new pick.
 */
export function usePageSearch(): string {
  return useSyncExternalStore(
    subscribeHashUrl,
    () => window.location.search,
    () => '',
  );
}

/**
 * The header's "App" control (the federated console): which app's runs the console shows, in the
 * kit's searchable `ScopeMenu` (this app first, federated apps hinted). Nothing when the console
 * shows only this app.
 */
export function AppPickerControl() {
  const picker = useAppPicker();
  const queryClient = useQueryClient();
  usePageSearch();
  const current = selectedApp();

  // An older server has no `/apps`: nothing to pick either.
  if (!picker || !Array.isArray(picker.apps) || picker.apps.length === 0) return null;

  const picked = current === undefined ? undefined : picker.apps.find((a) => a.id === current);
  const choose = (app: string | undefined) => {
    writeAppToUrl(app);
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'apps' });
  };
  const text = { ...APP_TEXT, all: picker.local.label, some: picker.local.label };

  return (
    <div className="flex items-center gap-1.5" data-app-picker>
      <ScopeMenu
        items={picker.apps.map((a) => ({
          id: a.id,
          label: a.label,
          ...(a.mode === 'federated' ? { hint: 'federated' } : {}),
        }))}
        // "Everything" here is this app: the option first, `?app=` absent.
        all
        current={current}
        text={text}
        labelOf={(id) => picker.apps.find((a) => a.id === id)?.label ?? id}
        onChoose={choose}
      />
      {picked && (
        <AppModeBadge appLabel={picked.label} mode={picked.mode} actions={picked.actions} />
      )}
    </div>
  );
}

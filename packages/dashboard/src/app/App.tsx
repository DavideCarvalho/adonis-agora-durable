import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { ActivityIcon, ClockIcon, ServerIcon } from '../agora-kit/icons';
import { AppShell, type NavSection, PageBody } from '../agora-kit/shell/app-shell';
import { readShellConfig } from '../agora-kit/shell-config';
import { CONFIG_ELEMENT_ID, durableClient } from '../client/durable-client';
import { currentRoute, pushRoute, type Route } from './routes';
import { LogoMark } from './run-status';
import { RunIdSearch } from './runs/RunIdSearch';
import { RunsPage, useRunFilters } from './runs/RunsPage';
import { SchedulesPanel } from './SchedulesPanel';
import { TenantPickerControl, useTenantPicker } from './TenantPicker';
import { WorkflowPage } from './WorkflowLifecycle';
import { WorkersPage } from './workers/WorkersPage';

/** Durable's accent (lime): passed to the kit's ThemeProvider in `main.tsx`. */
export const DURABLE_ACCENT = '#a3e635';

const TITLES: Record<Route['page'], string> = {
  runs: 'Runs',
  workers: 'Workers',
  schedules: 'Schedules',
  workflow: 'Workflow',
};

function LiveIndicator() {
  return (
    <span className="hidden items-center gap-1.5 text-[12px] text-dim sm:flex">
      <span className="dot s-completed pulse" aria-hidden />
      live
    </span>
  );
}

/**
 * The durable console: the Agora shell (kit) around three pages — MONITOR (Runs, Workers) and
 * OPERATIONS (Schedules, absent on a tenant deployment, whose gateway has no runtime schedule
 * control) — plus a workflow's page. Every page and region renders inside its own error boundary.
 */
export function App() {
  // What the provider put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const tenantPicker = useTenantPicker();
  const filters = useRunFilters();
  const [route, setRouteState] = useState<Route>(() => currentRoute());

  const navigate = useCallback((next: Route) => {
    setRouteState(next);
    pushRoute(next);
  }, []);
  // Every "open this run" affordance funnels here: it always lands on the runs board.
  const openRun = useCallback((id: string) => navigate({ page: 'runs', runId: id }), [navigate]);
  const selectRun = useCallback(
    (id?: string) => navigate(id ? { page: 'runs', runId: id } : { page: 'runs' }),
    [navigate],
  );
  // Follow back/forward and external hash edits.
  useEffect(() => {
    const sync = () => setRouteState(currentRoute());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  // Topology is fixed for a deployment's lifetime: fetch once. The role is the capability signal.
  const { data: topology } = useQuery({
    queryKey: ['topology'],
    queryFn: () => durableClient.topology(),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  const isTenant = topology?.role === 'tenant';
  const roleLabel = !topology
    ? ' '
    : isTenant
      ? topology.tenant
        ? `tenant · ${topology.tenant}`
        : 'tenant'
      : 'control plane';

  const nav = useMemo<NavSection[]>(
    () => [
      {
        section: 'Monitor',
        items: [
          {
            id: 'runs',
            label: 'Runs',
            icon: <ActivityIcon />,
            href: '#/',
            onSelect: () => navigate({ page: 'runs' }),
          },
          {
            id: 'workers',
            label: 'Workers',
            icon: <ServerIcon />,
            href: '#/workers',
            onSelect: () => navigate({ page: 'workers' }),
          },
        ],
      },
      {
        section: 'Operations',
        items: isTenant
          ? []
          : [
              {
                id: 'schedules',
                label: 'Schedules',
                icon: <ClockIcon />,
                href: '#/schedules',
                onSelect: () => navigate({ page: 'schedules' }),
              },
            ],
      },
    ],
    [isTenant, navigate],
  );

  const activeId = route.page === 'workflow' ? 'runs' : route.page;
  const title = route.page === 'workflow' ? route.workflow : TITLES[route.page];

  return (
    <AppShell
      brand={{
        name: 'durable',
        subtitle: (
          <span
            className={isTenant ? 'text-warn' : undefined}
            title={
              isTenant
                ? `Tenant deployment — partition ${topology?.tenant ?? '(unnamed)'}`
                : 'Control-plane deployment'
            }
          >
            {roleLabel}
          </span>
        ),
        mark: <LogoMark />,
        current: { title: 'Workflows', package: '@adonis-agora/durable', icon: 'workflow' },
      }}
      nav={nav}
      activeId={activeId}
      shell={shell}
      title={title}
      searchPlaceholder="Search runs, workflows, payments, users…"
      contentClassName={route.page === 'runs' ? 'overflow-hidden' : undefined}
      actions={
        <>
          <TenantPickerControl />
          <div className="hidden md:block">
            <RunIdSearch onOpenRun={openRun} />
          </div>
          <LiveIndicator />
        </>
      }
    >
      <ErrorBoundary label={TITLES[route.page]} resetKeys={[route.page]}>
        {route.page === 'workflow' ? (
          <PageBody>
            <WorkflowPage workflow={route.workflow} />
          </PageBody>
        ) : route.page === 'schedules' && !isTenant ? (
          <SchedulesPanel onOpenRun={openRun} />
        ) : route.page === 'workers' ? (
          <WorkersPage onOpenRun={openRun} />
        ) : (
          <RunsPage
            filters={filters}
            selected={route.page === 'runs' ? route.runId : undefined}
            onSelect={selectRun}
            onOpenRun={openRun}
            tenantPicker={tenantPicker}
          />
        )}
      </ErrorBoundary>
    </AppShell>
  );
}

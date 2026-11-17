import { type DurableDashboardOptions, durableDashboard } from './dashboard.js';
import {
  durableDurationProvider,
  durableFailedTriggersProvider,
  durableLifecycleTriggersProvider,
  durableOwedLifecycleProvider,
  durableRecentFailuresProvider,
  durableRunsOverTimeProvider,
  durableStateBreakdownProvider,
  durableStateProvider,
  durableSuccessRateProvider,
  durableThroughputProvider,
  durableTimeseriesProvider,
  durableWorkerHealthProvider,
  durableWorkerStatusProvider,
} from './data-providers.js';
import { durableSchedules } from './schedules.js';
import type { TelescopeExtension } from './telescope-sdk.js';
import { registerAutoWatcher } from './watcher.js';

/**
 * The first-class `@adonis-agora/telescope` extension for `@adonis-agora/durable`: a "Workflows" health dashboard
 * (golden signals) plus the data providers it binds to. Wire it into `config/telescope.ts`:
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/telescope'
 * import { durableTelescopeExtension } from '@adonis-agora/durable/telescope'
 *
 * export default defineConfig({ extensions: [durableTelescopeExtension()] })
 * ```
 *
 * At boot (its `entryTypes` hook) it also records durable's events with {@link registerAutoWatcher}
 * (the tagging watcher, unless the host wired one), which names `durable` in Telescope's watcher
 * list and gives each step's outcome its duration and step name, the "Slowest jobs" panel's input.
 * The `@adonis-agora/durable` provider bridges engine events onto the diagnostics bus; the
 * entry-backed providers read those `tag: 'lib:durable'` entries, the rest query the live engine.
 *
 * The returned object structurally satisfies `@adonis-agora/telescope`'s `TelescopeExtension` (it is not
 * imported — see `telescope-sdk.ts` for why).
 */
export function durableTelescopeExtension(opts: DurableDashboardOptions = {}): TelescopeExtension {
  return {
    name: 'durable',
    entryTypes: () => {
      // Telescope runs the hooks once at boot: record the events the Workflows pages read.
      registerAutoWatcher();
      return [{ id: 'durable', label: 'Workflows', dot: 'bg-amber-400' }];
    },
    dashboards: () => [durableDashboard(opts)],
    dataProviders: () => [
      durableStateProvider(),
      durableTimeseriesProvider(),
      durableRecentFailuresProvider(),
      durableWorkerHealthProvider(),
      durableWorkerStatusProvider(),
      durableDurationProvider(),
      durableRunsOverTimeProvider(),
      durableSuccessRateProvider(),
      durableThroughputProvider(),
      durableStateBreakdownProvider(),
      durableFailedTriggersProvider(),
      durableOwedLifecycleProvider(),
      durableLifecycleTriggersProvider(),
    ],
    schedules: (ctx) => durableSchedules(ctx),
  };
}

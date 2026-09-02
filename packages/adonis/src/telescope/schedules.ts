import { WorkflowEngine } from '../index.js';
import type { ExtensionContext, ScheduleContribution } from './telescope-sdk.js';

/**
 * Every schedule the engine discovered, in the shape telescope's Live Schedules
 * screen wants.
 *
 * The point is that nobody retypes the list. The engine already knows what
 * `@Scheduled` declared — `discoveredSchedules` IS that list — so the console shows
 * the decorators rather than a hand-kept copy of them that goes stale the first time
 * a cron changes and nobody remembers there are two places.
 *
 * Resolved from the container at call time (telescope calls this in its `ready()`),
 * so the engine is fully booted and discovery has run.
 */
export async function durableSchedules(ctx: ExtensionContext): Promise<ScheduleContribution[]> {
  const engine = await ctx.container.make<WorkflowEngine>(WorkflowEngine);
  return engine.discoveredSchedules.map(toContribution);
}

/**
 * Map one discovered schedule. `cron` and `everyMs` are mutually exclusive in the
 * decorator, which is exactly telescope's `cron` vs `interval` split.
 *
 * A paused schedule is still REPORTED: the console's job is to show what exists, and
 * silently omitting a paused job is how someone spends an afternoon wondering why
 * their cron "disappeared".
 */
function toContribution(schedule: {
  key: string;
  cron?: string;
  everyMs?: number;
  timezone?: string;
}): ScheduleContribution {
  if (typeof schedule.cron === 'string') {
    return {
      name: schedule.key,
      kind: 'cron',
      schedule: schedule.cron,
      timezone: schedule.timezone ?? null,
    };
  }
  return {
    name: schedule.key,
    kind: 'interval',
    schedule: schedule.everyMs !== undefined ? formatInterval(schedule.everyMs) : null,
    timezone: null,
  };
}

/** `120000` → `every 2m`. The screen shows this string as-is, so it has to read as English. */
function formatInterval(everyMs: number): string {
  const seconds = Math.round(everyMs / 1000);
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

import { flags } from '@adonisjs/core/ace';
import {
  cell,
  isoCell,
  pageFooter,
  renderTable,
  ScheduleCommand,
} from '../src/commands/console_command.js';
import { listSchedules } from '../src/dashboard/handlers.js';
import type { ScheduleInfo } from '../src/engine.js';

/**
 * `node ace durable:schedules` — the schedules the worker ticks, with their cadence, pause state and
 * current window, through the console's `GET /schedules` (same filters, sort and paging). A pause
 * set at runtime lives in the running workers, so this one-off process shows the configured state.
 */
export default class DurableSchedules extends ScheduleCommand {
  static override commandName = 'durable:schedules';
  static override description = 'List schedules: cadence, paused, last and next fire';

  @flags.string({ description: 'Only this workflow' })
  declare workflow?: string;

  @flags.string({ description: 'Only this namespace' })
  declare namespace?: string;

  @flags.string({ description: 'Only paused (true) or active (false) schedules' })
  declare paused?: string;

  @flags.string({ description: 'Sort: key, workflow, nextFireAt or lastFireAt (- for descending)' })
  declare sort?: string;

  @flags.number({ description: 'Page, 1-based (default 1)' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 100, at most 200)' })
  declare size?: number;

  protected async perform(): Promise<void> {
    await this.scheduleEngine();
    const filter: Record<string, string> = {};
    if (this.workflow) filter.workflow = this.workflow;
    if (this.namespace) filter.namespace = this.namespace;
    if (this.paused !== undefined) filter.paused = this.paused;
    const body = await this.call<{
      data: ScheduleInfo[];
      meta: { currentPage: number; lastPage: number; total: number };
    }>(listSchedules, {
      query: {
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        ...(this.sort ? { sort: this.sort } : {}),
        ...(this.page !== undefined ? { page: String(this.page) } : {}),
        ...(this.size !== undefined ? { size: String(this.size) } : {}),
      },
    });
    if (this.json) return this.printJson(body);
    this.logger.log(
      body.data.length === 0
        ? 'No schedules.'
        : renderTable(
            ['KEY', 'WORKFLOW', 'CADENCE', 'PAUSED', 'LAST FIRE', 'NEXT FIRE', 'LAST RUN'],
            body.data.map((s) => [
              s.key,
              s.workflow,
              s.cron ? `${s.cron}${s.timezone ? ` (${s.timezone})` : ''}` : `every ${s.everyMs}ms`,
              s.paused ? 'yes' : 'no',
              isoCell(s.lastFireAt),
              isoCell(s.nextFireAt),
              cell(s.lastRunStatus),
            ]),
          ),
    );
    if (body.meta.total > 0) this.logger.log(pageFooter(body.meta));
  }
}

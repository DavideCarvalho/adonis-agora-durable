import { args, flags } from '@adonisjs/core/ace';
import {
  cell,
  DurableConsoleCommand,
  pageFooter,
  renderTable,
} from '../src/commands/console_command.js';
import { getFanMembers } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:runs:fan <id> <group>` — one page of a wide fan's member steps (a fan
 * `durable:runs:show` summarized), through the console's `GET /runs/:id/fans/:group`.
 */
export default class DurableRunsFan extends DurableConsoleCommand {
  static override commandName = 'durable:runs:fan';
  static override description = "List a run's fan members, one page at a time";

  @args.string({ description: 'Run id' })
  declare id: string;

  @args.string({ description: 'Fan group, from durable:runs:show' })
  declare group: string;

  @flags.boolean({ description: 'Only failed members' })
  declare failed: boolean;

  @flags.number({ description: 'Page, 1-based (default 1)' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 100, at most 500)' })
  declare size?: number;

  protected async perform(): Promise<void> {
    const body = await this.call<{
      data: Array<Record<string, unknown>>;
      meta: { currentPage: number; lastPage: number; total: number };
    }>(getFanMembers, {
      params: { id: this.id, group: this.group },
      query: {
        ...(this.failed ? { filter: { status: 'failed' } } : {}),
        ...(this.page !== undefined ? { page: String(this.page) } : {}),
        ...(this.size !== undefined ? { size: String(this.size) } : {}),
      },
    });
    if (this.json) {
      this.printJson(body);
      return;
    }
    this.logger.log(
      body.data.length === 0
        ? 'No members.'
        : renderTable(
            ['SEQ', 'STEP', 'STATUS', 'ATTEMPTS', 'DURATION', 'ERROR'],
            body.data.map((s) => [
              cell(s.seq),
              cell(s.name),
              cell(s.status),
              cell(s.attempts),
              `${cell(s.durationMs)}ms`,
              s.error === undefined || s.error === null ? '-' : cell(s.error).slice(0, 80),
            ]),
          ),
    );
    this.logger.log(pageFooter(body.meta));
  }
}

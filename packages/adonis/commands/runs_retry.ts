import { args } from '@adonisjs/core/ace';
import { DurableConsoleCommand } from '../src/commands/console_command.js';
import { retryRun } from '../src/dashboard/handlers.js';
import type { RunResult } from '../src/index.js';

/**
 * `node ace durable:runs:retry <id>` — re-enqueue a failed or stuck run, through the console's
 * `POST /runs/:id/retry`: it goes back to `pending` and a worker resumes it, replaying completed
 * steps from their checkpoints and re-attempting the failed one.
 */
export default class DurableRunsRetry extends DurableConsoleCommand {
  static override commandName = 'durable:runs:retry';
  static override description = 'Re-enqueue (retry) a failed or stuck run';

  @args.string({ description: 'Run id' })
  declare id: string;

  protected async perform(): Promise<void> {
    this.audit(this.id);
    const body = await this.call<{ result: RunResult }>(retryRun, { params: { id: this.id } });
    if (this.json) return this.printJson(body);
    this.logger.success(`Run ${this.id} re-enqueued (status: ${body.result.status}).`);
  }
}

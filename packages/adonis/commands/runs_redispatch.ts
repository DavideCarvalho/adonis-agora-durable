import { args, flags } from '@adonisjs/core/ace';
import { DurableConsoleCommand } from '../src/commands/console_command.js';
import { redispatchPendingRun } from '../src/dashboard/handlers.js';
import type { RunResult } from '../src/index.js';

/**
 * `node ace durable:runs:redispatch <id>` — send a run's pending remote steps to their workers
 * again, through the console's `POST /runs/:id/redispatch`. For a step whose job was lost; on a step
 * a worker is still running it runs the step twice, so it asks first (`--force` skips).
 */
export default class DurableRunsRedispatch extends DurableConsoleCommand {
  static override commandName = 'durable:runs:redispatch';
  static override description = "Re-send a run's pending remote steps (a lost dispatch)";

  @args.string({ description: 'Run id' })
  declare id: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  protected async perform(): Promise<void> {
    await this.confirm(
      this.force,
      `Re-send the pending remote steps of ${this.id}? A step a worker is still running runs twice.`,
    );
    this.audit(this.id);
    const body = await this.call<{ result: RunResult }>(redispatchPendingRun, {
      params: { id: this.id },
    });
    if (this.json) return this.printJson(body);
    this.logger.success(`Run ${this.id}: pending steps re-sent (status: ${body.result.status}).`);
  }
}

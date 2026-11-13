import { args, flags } from '@adonisjs/core/ace';
import { DurableConsoleCommand } from '../src/commands/console_command.js';
import { cancelRun } from '../src/dashboard/handlers.js';
import type { RunResult } from '../src/index.js';

/**
 * `node ace durable:runs:cancel <id> [--compensate]` — cancel a run through the console's
 * `POST /runs/:id/cancel`; `--compensate` also runs the saga undo of its completed steps. Asks first
 * (`--force` skips).
 */
export default class DurableRunsCancel extends DurableConsoleCommand {
  static override commandName = 'durable:runs:cancel';
  static override description = 'Cancel a run (--compensate also runs its saga undo)';

  @args.string({ description: 'Run id' })
  declare id: string;

  @flags.boolean({ description: 'Also run the compensations of its completed steps (saga undo)' })
  declare compensate: boolean;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  protected async perform(): Promise<void> {
    await this.confirm(
      this.force,
      this.compensate ? `Cancel ${this.id} and run its compensations?` : `Cancel ${this.id}?`,
    );
    this.audit(this.id);
    const body = await this.call<{ result: RunResult }>(cancelRun, {
      params: { id: this.id },
      body: { compensate: this.compensate === true },
    });
    if (this.json) return this.printJson(body);
    this.logger.success(`Run ${this.id} cancelled (status: ${body.result.status}).`);
  }
}

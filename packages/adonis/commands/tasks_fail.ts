import { args, flags } from '@adonisjs/core/ace';
import { DurableConsoleCommand } from '../src/commands/console_command.js';
import { failTaskRun } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:tasks:fail <runId> <name> [--error '<message>']` — fail a `ctx.task` the run
 * handed to an external system, through the console's `POST /runs/:id/tasks/:name/fail`. Asks first
 * (`--force` skips).
 */
export default class DurableTasksFail extends DurableConsoleCommand {
  static override commandName = 'durable:tasks:fail';
  static override description = "Fail a run's external ctx.task";

  @args.string({ description: 'Run id' })
  declare runId: string;

  @args.string({ description: 'Task name' })
  declare name: string;

  // Not `error`: that name is the command's own failure slot on BaseCommand.
  @flags.string({
    flagName: 'error',
    description: 'The failure message (default "failed from console")',
  })
  declare failure?: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  protected async perform(): Promise<void> {
    await this.confirm(this.force, `Fail task ${this.name} of ${this.runId}?`);
    this.audit(`${this.runId} ${this.name}`);
    const body = await this.call<{ delivered: boolean }>(failTaskRun, {
      params: { id: this.runId, name: this.name },
      body: this.failure ? { error: this.failure } : {},
    });
    if (this.json) return this.printJson(body);
    this.logger.success(
      body.delivered
        ? `Task ${this.name} of ${this.runId} failed.`
        : `Task ${this.name} of ${this.runId}: failure kept until the run waits on it.`,
    );
  }
}

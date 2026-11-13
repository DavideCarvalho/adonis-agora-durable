import { args, flags } from '@adonisjs/core/ace';
import { DurableConsoleCommand, jsonFlag } from '../src/commands/console_command.js';
import { completeTaskRun } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:tasks:complete <runId> <name> [--result '<json>']` — complete a `ctx.task` the
 * run handed to an external system, through the console's `POST /runs/:id/tasks/:name/complete`.
 * When the run is not waiting on the task yet, the completion is kept for when it is.
 */
export default class DurableTasksComplete extends DurableConsoleCommand {
  static override commandName = 'durable:tasks:complete';
  static override description = "Complete a run's external ctx.task";

  @args.string({ description: 'Run id' })
  declare runId: string;

  @args.string({ description: 'Task name' })
  declare name: string;

  // Not `result`: that name is the command's own return slot on BaseCommand.
  @flags.string({ flagName: 'result', description: 'The task result, as JSON' })
  declare taskResult?: string;

  protected async perform(): Promise<void> {
    const result = jsonFlag('result', this.taskResult);
    this.audit(`${this.runId} ${this.name}`);
    const body = await this.call<{ delivered: boolean }>(completeTaskRun, {
      params: { id: this.runId, name: this.name },
      body: result !== undefined ? { result } : {},
    });
    if (this.json) return this.printJson(body);
    this.logger.success(
      body.delivered
        ? `Task ${this.name} of ${this.runId} completed.`
        : `Task ${this.name} of ${this.runId}: completion kept until the run waits on it.`,
    );
  }
}

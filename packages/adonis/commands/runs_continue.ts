import { args } from '@adonisjs/core/ace';
import { DurableConsoleCommand } from '../src/commands/console_command.js';
import { continueRun } from '../src/dashboard/handlers.js';
import type { RunResult } from '../src/index.js';

/**
 * `node ace durable:runs:continue <id>` — resume a run paused at a `ctx.breakpoint()`, through the
 * console's `POST /runs/:id/continue`. Fails when the run is not paused at one.
 */
export default class DurableRunsContinue extends DurableConsoleCommand {
  static override commandName = 'durable:runs:continue';
  static override description = 'Resume a run paused at a ctx.breakpoint()';

  @args.string({ description: 'Run id' })
  declare id: string;

  protected async perform(): Promise<void> {
    this.audit(this.id);
    const body = await this.call<{ result: RunResult }>(continueRun, { params: { id: this.id } });
    if (this.json) return this.printJson(body);
    this.logger.success(`Run ${this.id} continued (status: ${body.result.status}).`);
  }
}

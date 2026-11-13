import { args, flags } from '@adonisjs/core/ace';
import { DurableConsoleCommand, jsonFlag } from '../src/commands/console_command.js';
import { updateRun } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:runs:update <id> <name> [--arg '<json>']` — deliver an update to a run's
 * `ctx.onUpdate(name)` point, through the console's `POST /runs/:id/updates/:name`. The workflow's
 * validator decides; a rejection fails with its reason and nothing is delivered.
 */
export default class DurableRunsUpdate extends DurableConsoleCommand {
  static override commandName = 'durable:runs:update';
  static override description = "Deliver an update to a run's ctx.onUpdate point";

  @args.string({ description: 'Run id' })
  declare id: string;

  @args.string({ description: 'Update name' })
  declare name: string;

  @flags.string({ description: 'The update argument, as JSON' })
  declare arg?: string;

  protected async perform(): Promise<void> {
    const arg = jsonFlag('arg', this.arg);
    this.audit(`${this.id} ${this.name}`);
    const body = await this.call(updateRun, {
      params: { id: this.id, name: this.name },
      body: arg !== undefined ? { arg } : {},
    });
    if (this.json) return this.printJson(body);
    this.logger.success(`Update ${this.name} accepted by ${this.id}.`);
  }
}

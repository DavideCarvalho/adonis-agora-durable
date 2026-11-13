import { args } from '@adonisjs/core/ace';
import { DurableConsoleCommand } from '../src/commands/console_command.js';
import { getRunEvent } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:runs:event <id> <key>` — the latest value a run published for `key` with
 * `ctx.setEvent`, through the console's `GET /runs/:id/events/:key` (a live query, no side effect).
 */
export default class DurableRunsEvent extends DurableConsoleCommand {
  static override commandName = 'durable:runs:event';
  static override description = 'Read the latest value a run published with ctx.setEvent';

  @args.string({ description: 'Run id' })
  declare id: string;

  @args.string({ description: 'Event key' })
  declare key: string;

  protected async perform(): Promise<void> {
    const body = await this.call(getRunEvent, { params: { id: this.id, key: this.key } });
    this.printJson(this.json ? body : body.value);
  }
}

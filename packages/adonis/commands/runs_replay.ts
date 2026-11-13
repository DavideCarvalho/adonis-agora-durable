import { args, flags } from '@adonisjs/core/ace';
import { CliRefusal, DurableConsoleCommand, jsonFlag } from '../src/commands/console_command.js';
import { retryWithInputRun } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:runs:replay <id> --input '<json>'` — fix-and-replay, through the console's
 * `POST /runs/:id/retry-with-input`: start a fresh linked run of the same workflow with a corrected
 * input. The original run is left as it is.
 */
export default class DurableRunsReplay extends DurableConsoleCommand {
  static override commandName = 'durable:runs:replay';
  static override description = "Start a fresh run of a run's workflow with a corrected input";

  @args.string({ description: 'Run id' })
  declare id: string;

  @flags.string({ description: 'The corrected input, as JSON' })
  declare input?: string;

  protected async perform(): Promise<void> {
    if (this.input === undefined) throw new CliRefusal('--input is required (JSON).');
    const input = jsonFlag('input', this.input);
    this.audit(this.id);
    const body = await this.call<{ result: { runId: string } }>(retryWithInputRun, {
      params: { id: this.id },
      body: { input },
    });
    if (this.json) return this.printJson(body);
    this.logger.success(`Started ${body.result.runId} from ${this.id} with the corrected input.`);
  }
}

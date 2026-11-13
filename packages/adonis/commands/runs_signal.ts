import { args, flags } from '@adonisjs/core/ace';
import { DurableConsoleCommand, jsonFlag } from '../src/commands/console_command.js';
import { signalRun } from '../src/dashboard/handlers.js';
import type { RunResult } from '../src/index.js';

/**
 * `node ace durable:runs:signal <id> <token> [--payload '<json>']` — deliver a signal to a run
 * waiting on `token` (`ctx.waitForSignal`), through the console's `POST /runs/:id/signal`. Refused
 * when the run is not waiting on that token (the error lists the ones it waits on) unless
 * `--buffer`, which keeps it for the run's next wait.
 */
export default class DurableRunsSignal extends DurableConsoleCommand {
  static override commandName = 'durable:runs:signal';
  static override description = 'Deliver a signal to a run waiting on a token';

  @args.string({ description: 'Run id' })
  declare id: string;

  @args.string({ description: 'The signal token the run waits on' })
  declare token: string;

  @flags.string({ description: 'The payload, as JSON' })
  declare payload?: string;

  @flags.boolean({ description: 'Buffer it even when the run is not waiting on the token yet' })
  declare buffer: boolean;

  protected async perform(): Promise<void> {
    const payload = jsonFlag('payload', this.payload);
    this.audit(`${this.id} ${this.token}`);
    const body = await this.call<{ result: RunResult | null }>(signalRun, {
      params: { id: this.id },
      body: {
        token: this.token,
        ...(payload !== undefined ? { payload } : {}),
        force: this.buffer === true,
      },
    });
    if (this.json) return this.printJson(body);
    this.logger.success(
      body.result
        ? `Signal ${this.token} delivered to ${this.id} (status: ${body.result.status}).`
        : `Signal ${this.token} buffered for ${this.id}'s next wait.`,
    );
  }
}

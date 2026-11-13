import { args } from '@adonisjs/core/ace';
import { ScheduleCommand } from '../src/commands/console_command.js';
import { scheduleAction } from '../src/dashboard/handlers.js';
import type { RunResult } from '../src/index.js';

/**
 * `node ace durable:schedules:trigger <key>` — fire a schedule's current window now, through the
 * console's `POST /schedules/:key/trigger`. Idempotent: the window's run id is fixed, so a window
 * that already fired answers its existing run.
 */
export default class DurableSchedulesTrigger extends ScheduleCommand {
  static override commandName = 'durable:schedules:trigger';
  static override description = "Fire a schedule's current window now (idempotent)";

  @args.string({ description: 'Schedule key' })
  declare key: string;

  protected async perform(): Promise<void> {
    await this.scheduleEngine();
    this.audit(this.key);
    const body = await this.call<{ result: RunResult }>(scheduleAction, {
      params: { key: this.key, action: 'trigger' },
    });
    if (this.json) return this.printJson(body);
    this.logger.success(
      `Schedule ${this.key} fired: run ${body.result.runId} (status: ${body.result.status}).`,
    );
  }
}

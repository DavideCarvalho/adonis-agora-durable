import { args } from '@adonisjs/core/ace';
import { CliRefusal, ScheduleCommand } from '../src/commands/console_command.js';
import { scheduleAction } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:schedules:pause <key>` — pause a schedule fleet-wide through the console's
 * `POST /schedules/:key/pause`: broadcast on the control plane to every ticking worker. A runtime
 * override: the next deploy goes back to the config. Needs a control plane, since this process
 * exits right after.
 */
export default class DurableSchedulesPause extends ScheduleCommand {
  static override commandName = 'durable:schedules:pause';
  static override description = 'Pause a schedule fleet-wide (until resumed or redeployed)';

  /** `pause` here, `resume` in the subclass. */
  protected readonly verb: 'pause' | 'resume' = 'pause';

  @args.string({ description: 'Schedule key' })
  declare key: string;

  protected async perform(): Promise<void> {
    const engine = await this.scheduleEngine();
    if (engine && !(await engine.flushControl())) {
      throw new CliRefusal(
        `No control plane is configured, so a ${this.verb} from this process would reach no worker. ` +
          'Configure one in config/durable.ts, or use the console.',
      );
    }
    this.audit(this.key);
    const body = await this.call<{ key: string; paused: boolean }>(scheduleAction, {
      params: { key: this.key, action: this.verb },
    });
    await engine?.flushControl();
    if (this.json) return this.printJson(body);
    this.logger.success(`Schedule ${this.key} ${body.paused ? 'paused' : 'resumed'} fleet-wide.`);
  }
}

import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { renderRepublishResult, republishLifecycleTarget } from '../src/commands/runs.js';
import { WorkflowEngine } from '../src/index.js';

/**
 * `node ace durable:lifecycle:republish --run <id>` or `--workflow <name> [--since] [--until]` — publish
 * settled runs' lifecycle events again (`engine.republishLifecycle`). Backfills a subscriber
 * registered after the runs settled, or retries one that failed; a subscriber run that already
 * exists is not started again. Subscribers this app cannot deliver to are marked owed, for the
 * lifecycle sweep of an instance that can.
 */
export default class DurableLifecycleRepublish extends BaseCommand {
  static override commandName = 'durable:lifecycle:republish';
  static override description = "Publish settled runs' lifecycle events again";
  static override options: CommandOptions = { startApp: true };

  @flags.string({ flagName: 'run', description: 'One settled run id' })
  declare runId?: string;

  @flags.string({ description: 'Every settled run of this workflow' })
  declare workflow?: string;

  @flags.string({ description: 'With --workflow: runs settled at or after this ISO date/time' })
  declare since?: string;

  @flags.string({ description: 'With --workflow: runs settled at or before this ISO date/time' })
  declare until?: string;

  @flags.string({ description: 'With --workflow: completed or failed (both when absent)' })
  declare kind?: string;

  @flags.number({ description: 'With --workflow: at most this many runs (default 1000)' })
  declare limit?: number;

  @flags.string({ description: 'Only this subscribing workflow' })
  declare subscriber?: string;

  override async run(): Promise<void> {
    const target = republishLifecycleTarget({
      run: this.runId,
      workflow: this.workflow,
      since: this.since,
      until: this.until,
      kind: this.kind,
      limit: this.limit,
      subscriber: this.subscriber,
    });
    if ('error' in target) {
      this.logger.error(target.error);
      this.exitCode = 1;
      return;
    }
    const engine = await this.app.container.make(WorkflowEngine);
    const result = await engine.republishLifecycle(target);
    this.logger.info(renderRepublishResult(result));
    if (result.failed.length > 0) this.exitCode = 1;
  }
}

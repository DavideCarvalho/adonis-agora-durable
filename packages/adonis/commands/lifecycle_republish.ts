import { flags } from '@adonisjs/core/ace';
import { CliRefusal, DurableConsoleCommand } from '../src/commands/console_command.js';
import { renderRepublishResult, republishLifecycleTarget } from '../src/commands/runs.js';
import { republishLifecycleRun } from '../src/dashboard/handlers.js';
import type { RepublishLifecycleResult } from '../src/lifecycle-events.js';

/**
 * `node ace durable:lifecycle:republish --run <id>` or `--workflow <name> [--since] [--until]` — publish
 * settled runs' lifecycle events again. `--run` goes through the console's
 * `POST /runs/:id/republish-lifecycle`; `--workflow` through the same port's `republishLifecycle`.
 * Backfills a subscriber registered after the runs settled, or retries one that failed; a subscriber
 * run that already exists is not started again. Subscribers this app cannot deliver to are marked
 * owed, for the lifecycle sweep of an instance that can.
 */
export default class DurableLifecycleRepublish extends DurableConsoleCommand {
  static override commandName = 'durable:lifecycle:republish';
  static override description = "Publish settled runs' lifecycle events again";

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

  protected async perform(): Promise<void> {
    const target = republishLifecycleTarget({
      run: this.runId,
      workflow: this.workflow,
      since: this.since,
      until: this.until,
      kind: this.kind,
      limit: this.limit,
      subscriber: this.subscriber,
    });
    if ('error' in target) throw new CliRefusal(target.error);
    const deps = await this.deps();
    this.audit('runId' in target ? target.runId : `workflow ${target.workflow}`);
    let result: RepublishLifecycleResult;
    if ('runId' in target) {
      ({ result } = await this.call<{ result: RepublishLifecycleResult }>(
        republishLifecycleRun,
        {
          params: { id: target.runId },
          body: target.subscriber ? { subscriber: target.subscriber } : {},
        },
        deps,
      ));
    } else {
      if (!deps.engine.republishLifecycle) {
        throw new CliRefusal('republish is unavailable on this topology');
      }
      result = await deps.engine.republishLifecycle(target);
    }
    if (result.failed.length > 0) this.exitCode = 1;
    if (this.json) return this.printJson({ result });
    this.logger.info(renderRepublishResult(result));
  }
}

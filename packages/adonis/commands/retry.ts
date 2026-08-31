import { args, BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { retryRun } from '../src/commands/runs.js';
import { WorkflowEngine } from '../src/index.js';

/**
 * `node ace durable:retry <runId>` — re-enqueue a run for a worker to (re-)execute. Resolves the
 * engine bound by `@adonis-agora/durable`'s provider and calls its `requeue`: the run goes back to `pending`,
 * any stale lease is cleared, and a worker resumes it (replaying its checkpoints, re-attempting the
 * failed step). Run `durable:work` (or any worker) to pick it up.
 */
export default class DurableRetry extends BaseCommand {
  static override commandName = 'durable:retry';
  static override description = 'Re-enqueue (retry) a durable workflow run';
  static override options: CommandOptions = { startApp: true };

  @args.string({ description: 'The run id to retry' })
  declare runId: string;

  override async run(): Promise<void> {
    const engine = await this.app.container.make(WorkflowEngine);
    const result = await retryRun(engine, this.runId);
    if (!result) {
      this.logger.error(`Run ${this.runId} not found.`);
      this.exitCode = 1;
      return;
    }
    this.logger.success(`Run ${this.runId} re-enqueued (status: ${result.status}).`);
  }
}

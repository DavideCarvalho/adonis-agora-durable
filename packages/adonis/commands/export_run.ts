import { writeFile } from 'node:fs/promises';
import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { WorkflowEngine } from '../src/index.js';
import { captureHistory } from '../src/testing-kit/replay.js';

/**
 * `node ace durable:export <runId> [--out fixture.json]` — capture a run's replayable history (the
 * run row + its full checkpoint timeline) as JSON. Commit the file and assert it in CI with the
 * testing kit's `assertReplayable(register, parseRunHistory(json))`: a code change that renames /
 * reorders / removes a step at a position the history already recorded then fails the build instead
 * of corrupting an in-flight run on deploy.
 */
export default class DurableExport extends BaseCommand {
  static override commandName = 'durable:export';
  static override description =
    "Export a run's replay history as a JSON fixture for assertReplayable";
  static override options: CommandOptions = { startApp: true };

  @args.string({ description: 'The run id to export' })
  declare runId: string;

  @flags.string({ description: 'Write the fixture to this file instead of stdout' })
  declare out?: string;

  override async run(): Promise<void> {
    const engine = await this.app.container.make(WorkflowEngine);
    const history = await captureHistory(engine, this.runId);
    if (!history) {
      this.logger.error(`Run ${this.runId} not found.`);
      this.exitCode = 1;
      return;
    }
    const json = JSON.stringify(history, null, 2);
    if (this.out) {
      await writeFile(this.out, `${json}\n`, 'utf8');
      this.logger.success(
        `Exported ${history.checkpoints.length} checkpoint(s) of ${this.runId} to ${this.out}.`,
      );
      return;
    }
    console.log(json);
  }
}

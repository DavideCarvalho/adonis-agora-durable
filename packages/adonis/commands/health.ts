import { DurableConsoleCommand, renderTable } from '../src/commands/console_command.js';
import { fleetHealth } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:health` — per worker group the queue backlog and live workers (`stalled` is a
 * backlog with no worker), and how many runs are pending, dead or blocked: the same report as the
 * `durable_get_health` developer tool. Exit code 1 when a group is stalled.
 */
export default class DurableHealth extends DurableConsoleCommand {
  static override commandName = 'durable:health';
  static override description = 'Fleet health: backlog and live workers per group, run counts';

  protected async perform(): Promise<void> {
    const report = await fleetHealth(await this.deps());
    const stalled = report.groups.filter((g) => g.stalled);
    if (stalled.length > 0) this.exitCode = 1;
    if (this.json) return this.printJson(report);
    this.logger.log(
      report.groups.length === 0
        ? 'No worker groups.'
        : renderTable(
            ['GROUP', 'DEPTH', 'LIVE WORKERS', 'STALLED'],
            report.groups.map((g) => [
              g.group,
              String(g.depth),
              String(g.liveWorkers),
              g.stalled ? 'yes' : 'no',
            ]),
          ),
    );
    if (report.runs) {
      this.logger.log(
        `runs: ${report.runs.pending} pending, ${report.runs.dead} dead, ${report.runs.blocked} blocked`,
      );
    }
    for (const g of stalled) {
      this.logger.warning(`group ${g.group} is stalled: ${g.depth} queued, no live worker`);
    }
  }
}

import { DurableConsoleCommand, renderTable } from '../src/commands/console_command.js';
import { workers } from '../src/dashboard/handlers.js';
import type { GroupHealth } from '../src/index.js';

/**
 * `node ace durable:workers` — every worker group with its queue depth and each live worker's
 * heartbeat, through the console's `GET /workers`.
 */
export default class DurableWorkers extends DurableConsoleCommand {
  static override commandName = 'durable:workers';
  static override description = 'List worker groups and their live workers';

  protected async perform(): Promise<void> {
    const body = await this.call<{ data: GroupHealth[] }>(async (d) => workers(d));
    if (this.json) return this.printJson(body);
    const rows: string[][] = [];
    const now = Date.now();
    for (const group of body.data) {
      if (group.liveWorkers.length === 0) {
        rows.push([group.group, String(group.depth), '-', '-']);
        continue;
      }
      for (const worker of group.liveWorkers) {
        rows.push([
          group.group,
          String(group.depth),
          worker.instanceId,
          `${Math.max(0, Math.round((now - worker.lastBeatAt) / 1000))}s ago`,
        ]);
      }
    }
    this.logger.log(
      rows.length === 0
        ? 'No worker groups.'
        : renderTable(['GROUP', 'DEPTH', 'WORKER', 'LAST BEAT'], rows),
    );
  }
}

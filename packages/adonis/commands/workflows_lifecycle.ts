import { args } from '@adonisjs/core/ace';
import { cell, DurableConsoleCommand, renderTable } from '../src/commands/console_command.js';
import { workflowLifecycle } from '../src/dashboard/handlers.js';
import type { WorkflowLifecycleLinks } from '../src/lifecycle-events.js';

/**
 * `node ace durable:workflows:lifecycle <name>` — who starts whom through lifecycle events for one
 * workflow, through the console's `GET /workflows/:name/lifecycle`.
 */
export default class DurableWorkflowsLifecycle extends DurableConsoleCommand {
  static override commandName = 'durable:workflows:lifecycle';
  static override description = 'Show the workflows a workflow starts on settle, and is started by';

  @args.string({ description: 'Workflow name' })
  declare name: string;

  protected async perform(): Promise<void> {
    const body = await this.call<WorkflowLifecycleLinks>(workflowLifecycle, {
      params: { name: this.name },
    });
    if (this.json) {
      this.printJson(body);
      return;
    }
    const rows = [
      ...body.startsOnSettle.map((l) => ['starts', l.workflow, l.kind, l.local ? 'yes' : 'no']),
      ...body.startedBy.map((l) => ['started by', l.workflow, l.kind, l.local ? 'yes' : 'no']),
    ];
    this.logger.log(
      rows.length === 0
        ? `${this.name} has no lifecycle links.`
        : renderTable(
            ['DIRECTION', 'WORKFLOW', 'ON', 'LOCAL'],
            rows.map((r) => r.map(cell)),
          ),
    );
  }
}

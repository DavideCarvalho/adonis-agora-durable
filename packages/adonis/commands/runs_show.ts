import { args, flags } from '@adonisjs/core/ace';
import {
  CliRefusal,
  cell,
  DurableConsoleCommand,
  renderTable,
} from '../src/commands/console_command.js';
import { getRun } from '../src/dashboard/handlers.js';

/** Read a dotted path (`run.input`, `timeline.2.output`) out of a run detail. */
function pick(body: unknown, path: string): unknown {
  let cursor: unknown = body;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** A step's error, cut for a table cell. */
function errorCell(error: unknown): string {
  return error === undefined || error === null ? '-' : cell(error).slice(0, 80);
}

/**
 * `node ace durable:runs:show <id>` — one run's detail through the console's `GET /runs/:id`: the
 * run, its step timeline, children and fans. `--field run.output` prints one value in full.
 */
export default class DurableRunsShow extends DurableConsoleCommand {
  static override commandName = 'durable:runs:show';
  static override description = 'Show one run: status, input/output/error and its step timeline';

  @args.string({ description: 'Run id' })
  declare id: string;

  @flags.boolean({ description: 'List every member of wide fans instead of fan summaries' })
  declare full: boolean;

  @flags.string({ description: 'Print one dotted path of the detail in full, e.g. run.output' })
  declare field?: string;

  protected async perform(): Promise<void> {
    const body = await this.call(getRun, {
      params: { id: this.id },
      query: this.full ? { full: 'true' } : {},
    });
    if (this.field !== undefined) {
      const value = pick(body, this.field);
      if (value === undefined) throw new CliRefusal(`run ${this.id} has no field "${this.field}"`);
      this.printJson(this.json ? { id: this.id, field: this.field, value } : value);
      return;
    }
    if (this.json) {
      this.printJson(body);
      return;
    }
    const run = body.run as Record<string, unknown>;
    const lines = [
      `Run        ${cell(run.id)}`,
      `Workflow   ${cell(run.workflow)}@${cell(run.workflowVersion)}`,
      `Status     ${cell(run.status)}`,
      `Namespace  ${cell(run.namespace)}`,
      ...(run.tenantId !== undefined ? [`Tenant     ${cell(run.tenantId)}`] : []),
      `Tags       ${Array.isArray(run.tags) && run.tags.length > 0 ? run.tags.join(', ') : '-'}`,
      `Created    ${cell(run.createdAt)}`,
      `Updated    ${cell(run.updatedAt)}`,
      ...(run.waiting !== undefined ? [`Waiting    ${cell(run.waiting)}`] : []),
      `Input      ${cell(run.input)}`,
      `Output     ${cell(run.output)}`,
      ...(run.error !== undefined && run.error !== null ? [`Error      ${cell(run.error)}`] : []),
    ];
    this.logger.log(lines.join('\n'));
    const timeline = (body.timeline as Array<Record<string, unknown>> | undefined) ?? [];
    this.logger.log(
      timeline.length === 0
        ? '\nNo steps.'
        : `\n${renderTable(
            ['SEQ', 'STEP', 'KIND', 'STATUS', 'ATTEMPTS', 'DURATION', 'ERROR'],
            timeline.map((s) => [
              cell(s.seq),
              cell(s.name),
              cell(s.kind),
              cell(s.status),
              cell(s.attempts),
              `${cell(s.durationMs)}ms`,
              errorCell(s.error),
            ]),
          )}`,
    );
    for (const fan of (body.fans as Array<Record<string, unknown>> | undefined) ?? []) {
      const counts = (fan.counts as Record<string, number> | undefined) ?? {};
      this.logger.log(
        `fan ${cell(fan.group)} (${cell(fan.label)}): ${cell(fan.size)} member(s), ${counts.failed ?? 0} failed; list them with durable:runs:fan ${this.id} ${cell(fan.group)}`,
      );
    }
    const children = (body.children as string[] | undefined) ?? [];
    if (children.length > 0) {
      const count = typeof body.childCount === 'number' ? body.childCount : children.length;
      this.logger.log(`children (${count}): ${children.join(', ')}`);
    }
  }
}

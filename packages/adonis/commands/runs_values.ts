import { args, flags } from '@adonisjs/core/ace';
import { cell, RunFilterCommand, renderTable } from '../src/commands/console_command.js';
import { runValues } from '../src/dashboard/handlers.js';

/**
 * `node ace durable:runs:values <field>` — count the runs matching the filters by one field
 * (`status`, `workflow`, `namespace`, `tag`, `attr` for search-attribute keys, `attr.<key>` for one
 * key's values), through the console's `GET /runs/values`.
 */
export default class DurableRunsValues extends RunFilterCommand {
  static override commandName = 'durable:runs:values';
  static override description = 'Count runs by status, workflow, namespace, tag or attribute';

  @args.string({ description: 'status | workflow | namespace | tag | attr | attr.<key>' })
  declare field: string;

  @flags.number({ description: 'At most this many values (default 20)' })
  declare limit?: number;

  @flags.string({ description: 'Only values containing this text' })
  declare search?: string;

  protected async perform(): Promise<void> {
    const values = await this.call<Array<{ value: unknown; count: number }>>(runValues, {
      query: {
        ...this.runFilter(),
        field: this.field,
        ...(this.limit !== undefined ? { limit: String(this.limit) } : {}),
        ...(this.search ? { search: this.search } : {}),
      },
    });
    if (this.json) {
      this.printJson({ field: this.field, data: values });
      return;
    }
    this.logger.log(
      values.length === 0
        ? 'No values.'
        : renderTable(
            [this.field.toUpperCase(), 'RUNS'],
            values.map((v) => [cell(v.value), String(v.count)]),
          ),
    );
  }
}

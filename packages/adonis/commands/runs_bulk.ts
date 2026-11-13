import { args, flags } from '@adonisjs/core/ace';
import { CliRefusal, RunFilterCommand } from '../src/commands/console_command.js';
import { renderRunsTable } from '../src/commands/runs.js';
import { bulkAction, listRuns } from '../src/dashboard/handlers.js';
import type { WorkflowRun } from '../src/index.js';

/** The bulk action acts on at most this many matching runs (the console's cap). */
const BULK_CAP = 500;

/**
 * `node ace durable:runs:bulk <retry|cancel> [filters]` — retry or cancel every run matching the
 * filters (at most 500), through the console's `POST /bulk/:action`. A run that cannot take the
 * action is skipped. `--dry-run` lists what would be acted on; otherwise it asks first (`--force`
 * skips).
 */
export default class DurableRunsBulk extends RunFilterCommand {
  static override commandName = 'durable:runs:bulk';
  static override description = 'Retry or cancel every run matching a filter (at most 500)';

  @args.string({ description: 'retry | cancel' })
  declare action: string;

  @flags.boolean({ description: 'With cancel: also run each run’s compensations (saga undo)' })
  declare compensate: boolean;

  @flags.boolean({ description: 'List the matching runs and stop' })
  declare dryRun: boolean;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force: boolean;

  protected async perform(): Promise<void> {
    if (this.action !== 'retry' && this.action !== 'cancel') {
      throw new CliRefusal('action must be retry or cancel.');
    }
    if (this.compensate && this.action !== 'cancel') {
      throw new CliRefusal('--compensate goes with cancel.');
    }
    const query = this.runFilter();
    const deps = await this.deps();
    const preview = await this.call<{
      data: Array<Record<string, unknown> & { updatedAt: string }>;
      meta: { total: number };
    }>(listRuns, { query: { ...query, size: '200' } }, deps);
    const matched = preview.meta.total;
    const acting = Math.min(matched, BULK_CAP);
    const scope =
      Object.keys(query).length > 0 ? 'matching the filter' : 'of every run (no filter)';

    if (this.dryRun) {
      if (this.json) {
        this.printJson({ action: this.action, matched, wouldApply: acting, data: preview.data });
        return;
      }
      const rows = preview.data.map((row) => ({
        run: { ...row, updatedAt: new Date(row.updatedAt) } as unknown as WorkflowRun,
        ageMs: Date.now() - new Date(row.updatedAt).getTime(),
        recoveryAttempts: Number(row.recoveryAttempts ?? 0),
        stalePending: null,
      }));
      this.logger.log(renderRunsTable(rows));
      this.logger.info(
        `Dry run: ${this.action} would act on ${acting} run(s) ${scope} (${matched} matched${matched > BULK_CAP ? `, capped at ${BULK_CAP}` : ''}).`,
      );
      return;
    }

    await this.confirm(
      this.force,
      `${this.action === 'retry' ? 'Retry' : 'Cancel'} up to ${acting} run(s) ${scope}${this.compensate ? ' and run their compensations' : ''}?`,
    );
    this.audit(`${this.action} ${JSON.stringify(query.filter ?? {})}`);
    const body = await this.call<{ matched: number; applied: number }>(
      bulkAction,
      {
        params: { action: this.action },
        query,
        ...(this.compensate ? { body: { compensate: true } } : {}),
      },
      deps,
    );
    if (this.json) return this.printJson(body);
    this.logger.success(
      `${this.action}: applied to ${body.applied} of ${body.matched} matching run(s).`,
    );
  }
}

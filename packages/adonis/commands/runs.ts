import { flags } from '@adonisjs/core/ace';
import { pageFooter, RunFilterCommand } from '../src/commands/console_command.js';
import {
  attachLiveness,
  DEFAULT_STALE_MS,
  filterStale,
  parseDurationMs,
  renderRunsTable,
  staleHint,
} from '../src/commands/runs.js';
import { listRuns } from '../src/dashboard/handlers.js';
import type { WorkflowRun } from '../src/index.js';

/** One row of the console's `GET /runs` page. */
interface RunRow {
  id: string;
  workflow: string;
  status: WorkflowRun['status'];
  updatedAt: string;
  recoveryAttempts: number;
  [key: string]: unknown;
}

/**
 * `node ace durable:runs` — list runs, newest first, through the console's `GET /runs` handler (same
 * filters, paging, tenant scope and redaction). Every row carries liveness signals (UPDATED age,
 * RECOVERY attempts, PENDING remote-step age); `--stale` narrows the page to the runs that look
 * stranded by them.
 */
export default class DurableRuns extends RunFilterCommand {
  static override commandName = 'durable:runs';
  static override description = 'List durable workflow runs (filters, paging, --stale)';

  @flags.number({ description: 'Page, 1-based (default 1)' })
  declare page?: number;

  @flags.number({ description: 'Rows per page (default 50, at most 200)' })
  declare size?: number;

  @flags.string({
    allowEmptyValue: true,
    description:
      'Only running/suspended/cancelling runs whose oldest pending remote step exceeds this age (the ' +
      '"probably stranded" view). Bare --stale uses 15m; --stale=1h / --stale=90s set your own.',
  })
  declare stale?: string;

  protected async perform(): Promise<void> {
    const wantsStale = this.stale !== undefined;
    const query = this.runFilter() as { filter?: Record<string, unknown> };
    // No explicit --status: `--stale` reads the only statuses a stranded dispatch shows up in, so
    // newer terminal runs don't push a stale candidate off the page.
    if (wantsStale && !query.filter?.status) {
      query.filter = { ...query.filter, status: ['running', 'suspended', 'cancelling'] };
    }
    const deps = await this.deps();
    const body = await this.call<{
      data: RunRow[];
      meta: { currentPage: number; lastPage: number; total: number };
    }>(
      listRuns,
      {
        query: {
          ...query,
          ...(this.page !== undefined ? { page: String(this.page) } : {}),
          ...(this.size !== undefined ? { size: String(this.size) } : {}),
        },
      },
      deps,
    );

    // The liveness columns read each in-flight run's checkpoints through the same port.
    const runs = body.data.map(
      (row) => ({ ...row, updatedAt: new Date(row.updatedAt) }) as unknown as WorkflowRun,
    );
    const lister = {
      listRuns: async () => runs,
      listCheckpoints: (id: string) => deps.engine.listCheckpoints(id),
    };
    let live = await attachLiveness(lister, runs);
    if (wantsStale) {
      const threshold =
        this.stale === ''
          ? DEFAULT_STALE_MS
          : (parseDurationMs(this.stale ?? '') ?? DEFAULT_STALE_MS);
      live = filterStale(live, threshold);
    }

    if (this.json) {
      const kept = new Set(live.map((l) => l.run.id));
      const liveness = new Map(live.map((l) => [l.run.id, l.stalePending]));
      this.printJson({
        data: body.data
          .filter((row) => kept.has(row.id))
          .map((row) => ({ ...row, pending: liveness.get(row.id) ?? null })),
        meta: body.meta,
      });
      return;
    }
    this.logger.log(renderRunsTable(live));
    if (live.length > 0 || body.meta.total > 0) this.logger.log(pageFooter(body.meta));
    if (wantsStale) for (const { run } of live) this.logger.warning(staleHint(run.id));
  }
}

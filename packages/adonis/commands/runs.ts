import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import {
  attachLiveness,
  DEFAULT_STALE_MS,
  filterStale,
  listRuns,
  parseDurationMs,
  renderRunsTable,
  staleHint,
} from '../src/commands/runs.js';
import { type RunStatus, WorkflowEngine } from '../src/index.js';

/**
 * `node ace durable:runs` — list recent workflow runs, optionally filtered by status and workflow.
 * Reads through the engine's read API (`engine.listRuns`/`engine.listCheckpoints`); for the listing to
 * show runs across processes the engine must be backed by a persistent store (config/durable.ts).
 *
 * Every row also carries liveness signals (UPDATED age, RECOVERY attempts, PENDING remote-step age) —
 * `suspended` alone can't tell a run mid-step apart from one whose dispatch was lost (see
 * `src/commands/runs.ts`'s module doc). `--stale` narrows the listing to exactly the runs that look
 * stranded by that signal.
 */
export default class DurableRuns extends BaseCommand {
  static override commandName = 'durable:runs';
  static override description = 'List recent durable workflow runs';
  static override options: CommandOptions = { startApp: true };

  @flags.string({
    description: 'Filter by status (pending|running|suspended|completed|failed|cancelled|dead)',
  })
  declare status?: string;

  @flags.string({ description: 'Filter by workflow name' })
  declare workflow?: string;

  @flags.number({ description: 'Max runs to list', default: 50 })
  declare limit: number;

  @flags.string({
    description:
      'List only running/suspended runs whose oldest pending remote step exceeds this age — the ' +
      '"probably stranded" view. Pass bare --stale for the default threshold (15m), or a duration ' +
      'like --stale=1h / --stale=90s for a custom one.',
  })
  declare stale?: string;

  override async run(): Promise<void> {
    const engine = await this.app.container.make(WorkflowEngine);
    const wantsStale = this.stale !== undefined;
    const runs = await listRuns(engine, {
      ...(this.status ? { status: this.status as RunStatus } : {}),
      // No explicit --status: scope the query to running/suspended, the only statuses a stranded
      // dispatch can show up in, so a stale candidate isn't pushed out of the window by newer
      // terminal runs.
      ...(!this.status && wantsStale ? { statuses: ['running', 'suspended'] as RunStatus[] } : {}),
      ...(this.workflow ? { workflow: this.workflow } : {}),
      limit: this.limit,
    });
    const liveRuns = await attachLiveness(engine, runs);

    if (!wantsStale) {
      this.logger.log(renderRunsTable(liveRuns));
      return;
    }

    const thresholdMs =
      this.stale === ''
        ? DEFAULT_STALE_MS
        : (parseDurationMs(this.stale ?? '') ?? DEFAULT_STALE_MS);
    const stale = filterStale(liveRuns, thresholdMs);
    this.logger.log(renderRunsTable(stale));
    for (const { run } of stale) this.logger.warning(staleHint(run.id));
  }
}

import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { mergeSchedules, runWorkerLoop } from '../src/commands/worker.js';
import type { DurableConfig } from '../src/define_config.js';
import { WorkflowEngine } from '../src/index.js';
import { resolveSchedules } from '../src/scheduler.js';

/**
 * `node ace durable:work` — the long-running worker loop. Resolves the {@link WorkflowEngine} bound by
 * `@adonis-agora/durable`'s provider, then on an interval picks up pending runs, recovers crashed runs,
 * resumes due timers, sweeps execution timeouts, and fires any `schedules` configured in
 * `config/durable.ts`. Stays alive until SIGINT/SIGTERM, then drains in-flight executions so a deploy
 * hands off cleanly.
 */
export default class DurableWork extends BaseCommand {
  static override commandName = 'durable:work';
  static override description =
    'Run the durable workflow worker loop (pending, recovery, timers, timeouts, schedules)';
  static override options: CommandOptions = { startApp: true, staysAlive: true };

  @flags.number({ description: 'Poll interval in milliseconds between ticks', default: 1000 })
  declare interval: number;

  @flags.number({ description: 'Drain timeout in milliseconds on shutdown', default: 10_000 })
  declare drainTimeout: number;

  override async run(): Promise<void> {
    const engine = await this.app.container.make(WorkflowEngine);
    // Recurring schedules fired as the worker tick's 5th phase: those registered in `config/durable.ts`
    // merged with any colocated `static schedule` discovered on workflow classes at boot. Config wins
    // on a key collision (see `mergeSchedules`).
    const config = this.app.config.get<DurableConfig>('durable', {});
    // `resolveSchedules` calls the lazy `() => import('#workflows/…')` entries — now, after boot.
    const schedules = mergeSchedules(
      await resolveSchedules(config.schedules ?? []),
      engine.discoveredSchedules,
    );

    // Resolve `stopSignal` once a termination signal arrives, so the loop finishes its current tick,
    // drains, and exits cleanly instead of being hard-killed mid-run.
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const onSignal = (): void => {
      this.logger.info('shutdown signal received — stopping worker…');
      stop();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    this.logger.info(`durable:work started (interval ${this.interval}ms)`);
    await runWorkerLoop(engine, {
      intervalMs: this.interval,
      drainTimeoutMs: this.drainTimeout,
      stopSignal,
      schedules,
      logger: { info: (m) => this.logger.info(m), error: (m) => this.logger.error(m) },
    });

    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // Let ace tear the staysAlive command down now that the loop has returned.
    await this.terminate();
  }
}

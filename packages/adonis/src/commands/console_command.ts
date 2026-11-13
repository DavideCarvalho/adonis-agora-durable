import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { cliActor, recordConsoleAudit } from '../dashboard/audit.js';
import type { DurableDashboardConfig } from '../dashboard/define_config.js';
import { dashboardEngineForTopology } from '../dashboard/gateway-adapter.js';
import type { ApiRequest, ApiResponse, Deps } from '../dashboard/handlers.js';
import { scopedDashboardEngine } from '../dashboard/tenant_scope.js';
import type { DurableConfig } from '../define_config.js';
import { WorkflowEngine } from '../engine.js';
import { resolveSchedules } from '../scheduler.js';
import { tenancyEnabled, tenancySlot } from '../tenancy.js';
import { mergeSchedules } from './worker.js';

/** A refusal the command reports on stderr with exit code 1 (bad flags, a refused confirmation). */
export class CliRefusal extends Error {}

/**
 * The base of the `durable:*` operator commands: they run the console's own JSON handlers
 * (`src/dashboard/handlers.ts`) over the same read/control port, so a command validates, scopes and
 * answers exactly like the console and the developer tools. Adds `--json`, `--tenant`, the console
 * audit (actor `cli:<os user>`) and the `--force` confirmation for destructive actions.
 */
export abstract class DurableConsoleCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Print JSON instead of a table' })
  declare json: boolean;

  @flags.string({ description: 'Only this tenant (organization) id, when tenancy is on' })
  declare tenant?: string;

  /** Whether a confirmation can be asked on this terminal. Tests set it. */
  protected interactive = process.stdin.isTTY === true;

  /** The command's work; throw {@link CliRefusal} to refuse with exit code 1. */
  protected abstract perform(): Promise<void>;

  override async run(): Promise<void> {
    try {
      await this.perform();
    } catch (error) {
      if (!(error instanceof CliRefusal)) throw error;
      this.logger.error(error.message);
      this.exitCode = 1;
    }
  }

  /**
   * The console's read/control port for this process: the engine (or a tenant pod's gateway), read
   * across every tenant, or confined to `--tenant`. The console's `redact` hooks apply.
   */
  protected async deps(): Promise<Deps> {
    const durable = this.app.config.get<DurableConfig>('durable', {});
    const base = await dashboardEngineForTopology(
      durable.topology ?? 'standalone',
      this.app.container as Parameters<typeof dashboardEngineForTopology>[1],
      WorkflowEngine,
    );
    const slot = tenancyEnabled(durable.tenancy) ? tenancySlot() : undefined;
    const tenant = this.tenant?.trim() || undefined;
    if (tenant !== undefined && !slot) {
      throw new CliRefusal('--tenant needs tenancy on (config/durable.ts `tenancy`).');
    }
    const engine = slot
      ? scopedDashboardEngine(base, tenant !== undefined ? [tenant] : undefined, (fn) =>
          slot.allTenants(fn),
        )
      : base;
    const redact = this.app.config.get<DurableDashboardConfig>('durable_dashboard', {}).redact;
    return { engine, ...(redact ? { redact } : {}) };
  }

  /** Run one console handler; a non-2xx answer becomes a {@link CliRefusal} with its message. */
  protected async call<T = Record<string, unknown>>(
    handler: (deps: Deps, req: ApiRequest) => Promise<ApiResponse>,
    req: Partial<ApiRequest> = {},
    deps?: Deps,
  ): Promise<T> {
    const response = await handler(deps ?? (await this.deps()), {
      params: {},
      query: {},
      ...req,
    });
    if (response.status >= 200 && response.status < 300) return response.body as T;
    const body = response.body as { error?: unknown; waitingOn?: unknown } | null;
    let message = typeof body?.error === 'string' ? body.error : `failed (${response.status})`;
    if (Array.isArray(body?.waitingOn) && body.waitingOn.length > 0) {
      message += ` — waiting on: ${body.waitingOn.join(', ')}`;
    }
    throw new CliRefusal(message);
  }

  /**
   * Record one action through the console's audit (the host's `audit` hook, else the log line), as
   * `cli:<os user>`, `CLI`, `<command> <target>`. Called before the action, like a console POST.
   */
  protected audit(target: string): void {
    const sink = this.app.config.get<DurableDashboardConfig>('durable_dashboard', {}).audit;
    recordConsoleAudit(sink, () => this.app.container.make('logger'), {
      at: new Date(),
      actor: cliActor(),
      method: 'CLI',
      path: `${(this.constructor as typeof BaseCommand).commandName} ${target}`.trim(),
    });
  }

  /** Ask before a destructive action; `--force` skips it, and without a terminal it is required. */
  protected async confirm(force: boolean | undefined, question: string): Promise<void> {
    if (force === true) return;
    if (!this.interactive) {
      throw new CliRefusal(`${question} Refused: no terminal to confirm on, pass --force.`);
    }
    const yes = await this.prompt.confirm(question, { name: 'confirm' });
    if (!yes) throw new CliRefusal('Aborted.');
  }

  /** Print a value as one JSON document. */
  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }
}

/** Parse a `--payload`-style flag as JSON, or `undefined` when absent. */
export function jsonFlag(name: string, raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliRefusal(`--${name} must be valid JSON.`);
  }
}

/** Split repeated and comma-separated flag values into one list. */
export function listFlag(raw: string | string[] | undefined): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

/** A plain-text table. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join('\n');
}

/** A cell for a possibly-missing value. */
export function cell(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Epoch ms or ISO string as an ISO string (`-` when absent). */
export function isoCell(value: unknown): string {
  if (typeof value === 'number') return new Date(value).toISOString();
  return cell(value);
}

/** The `page X of Y (N total)` footer of an offset page. */
export function pageFooter(meta: { currentPage: number; lastPage: number; total: number }): string {
  return `page ${meta.currentPage} of ${Math.max(meta.lastPage, 1)} (${meta.total} total)`;
}

/**
 * A {@link DurableConsoleCommand} that takes the console's run filter (`filter[...]` on the wire):
 * `--status`, `--workflow`, `--tag`, `--namespace`, `--origin`, `--attr`, `--created-after`,
 * `--created-before`. Several values (repeated, or comma separated) match any of them.
 */
export abstract class RunFilterCommand extends DurableConsoleCommand {
  @flags.array({
    description:
      'Run status (pending|running|suspended|blocked|cancelling|completed|failed|cancelled|dead); several match any',
  })
  declare status?: string[];

  @flags.array({ description: 'Workflow name; several match any' })
  declare workflow?: string[];

  @flags.array({ description: 'A tag the run carries; several match any' })
  declare tag?: string[];

  @flags.array({ description: 'Worker namespace; several match any' })
  declare namespace?: string[];

  @flags.string({ description: 'Origin attribution' })
  declare origin?: string;

  @flags.array({ description: 'Search attribute predicate key:op:value (tier:eq:pro); ANDed' })
  declare attr?: string[];

  @flags.string({ description: 'Only runs created at or after this ISO date/time' })
  declare createdAfter?: string;

  @flags.string({ description: 'Only runs created at or before this ISO date/time' })
  declare createdBefore?: string;

  /** The flags as the console's `filter[...]` envelope (`{ filter: { status: [...] } }`). */
  protected runFilter(): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    const lists = {
      status: this.status,
      workflow: this.workflow,
      tag: this.tag,
      namespace: this.namespace,
    };
    for (const [key, raw] of Object.entries(lists)) {
      const values = listFlag(raw);
      if (values.length > 0) filter[key] = values;
    }
    const attrs = (this.attr ?? []).map((a) => a.trim()).filter(Boolean);
    if (attrs.length > 0) filter.attr = attrs;
    for (const [key, value] of Object.entries({
      origin: this.origin,
      createdAfter: this.createdAfter,
      createdBefore: this.createdBefore,
    })) {
      if (value !== undefined && value !== '') filter[key] = value;
    }
    for (const key of ['createdAfter', 'createdBefore'] as const) {
      const value = filter[key];
      if (typeof value === 'string' && Number.isNaN(new Date(value).getTime())) {
        throw new CliRefusal(
          `--${key === 'createdAfter' ? 'created-after' : 'created-before'} is not a date: ${value}`,
        );
      }
    }
    return Object.keys(filter).length > 0 ? { filter } : {};
  }
}

/**
 * A {@link DurableConsoleCommand} over the schedules. A one-off process runs no worker loop, so it
 * first adopts the set `durable:work` ticks (`config.schedules` merged with colocated `static
 * schedule`s), and the console's schedule handlers see the same keys.
 */
export abstract class ScheduleCommand extends DurableConsoleCommand {
  /** This process's engine, with the worker's schedule set adopted; `undefined` on a tenant pod. */
  protected async scheduleEngine(): Promise<WorkflowEngine | undefined> {
    const durable = this.app.config.get<DurableConfig>('durable', {});
    if ((durable.topology ?? 'standalone') === 'tenant') return undefined;
    const engine = await this.app.container.make(WorkflowEngine);
    engine.adoptSchedules(
      mergeSchedules(await resolveSchedules(durable.schedules ?? []), engine.discoveredSchedules),
    );
    return engine;
  }
}

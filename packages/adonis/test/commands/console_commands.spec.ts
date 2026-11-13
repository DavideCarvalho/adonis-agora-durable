import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BaseCommand } from '@adonisjs/core/ace';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import DurableHealth from '../../commands/health.js';
import DurableLifecycleRepublish from '../../commands/lifecycle_republish.js';
import { DURABLE_COMMANDS } from '../../commands/main.js';
import DurableRuns from '../../commands/runs.js';
import DurableRunsBulk from '../../commands/runs_bulk.js';
import DurableRunsCancel from '../../commands/runs_cancel.js';
import DurableRunsContinue from '../../commands/runs_continue.js';
import DurableRunsEvent from '../../commands/runs_event.js';
import DurableRunsFan from '../../commands/runs_fan.js';
import DurableRunsRedispatch from '../../commands/runs_redispatch.js';
import DurableRunsReplay from '../../commands/runs_replay.js';
import DurableRunsRetry from '../../commands/runs_retry.js';
import DurableRunsShow from '../../commands/runs_show.js';
import DurableRunsSignal from '../../commands/runs_signal.js';
import DurableRunsUpdate from '../../commands/runs_update.js';
import DurableRunsValues from '../../commands/runs_values.js';
import DurableSchedules from '../../commands/schedules.js';
import DurableSchedulesPause from '../../commands/schedules_pause.js';
import DurableSchedulesResume from '../../commands/schedules_resume.js';
import DurableSchedulesTrigger from '../../commands/schedules_trigger.js';
import DurableTasksComplete from '../../commands/tasks_complete.js';
import DurableTasksFail from '../../commands/tasks_fail.js';
import DurableWorkers from '../../commands/workers.js';
import DurableWorkflowsLifecycle from '../../commands/workflows_lifecycle.js';
import type { DashboardAuditEntry } from '../../src/dashboard/define_config.js';
import {
  type ControlMessage,
  type ControlPlane,
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '../../src/index.js';
import { contextEngineTenancy } from '../../src/tenancy.js';

type Ace = Awaited<ReturnType<AceFactory['make']>>;
type CommandClass = typeof BaseCommand;

let appRoot: string;
let ace: Ace;
let engine: WorkflowEngine;
let audits: DashboardAuditEntry[];
let seq = 0;

/** A control plane that records what it was asked to broadcast. */
class RecordingControlPlane implements ControlPlane {
  readonly sent: ControlMessage[] = [];
  async publishControl(msg: ControlMessage): Promise<void> {
    this.sent.push(msg);
  }
  onControl(): void {}
}

function makeEngine(controlPlane?: ControlPlane): WorkflowEngine {
  const e = new WorkflowEngine({
    store: new InMemoryStateStore(),
    transport: new InMemoryTransport(),
    ...(controlPlane ? { controlPlane } : {}),
  });
  e.register('greet', '1', async (ctx, input) => {
    const { name } = input as { name: string };
    return ctx.localStep('hello', async () => `hello ${name}`);
  });
  e.register('boom', '1', async (ctx) => {
    await ctx.localStep('explode', async () => {
      throw new Error('kaboom');
    });
  });
  e.register('waiter', '1', async (ctx) => {
    await ctx.setEvent('progress', { pct: 50 });
    return ctx.waitForSignal('go');
  });
  e.register('pausable', '1', async (ctx) => {
    await ctx.breakpoint();
    return 'resumed';
  });
  e.register('tasker', '1', async (ctx) => ctx.task('approve', async () => undefined));
  e.register('updatable', '1', async (ctx) => ctx.onUpdate('bump'));
  return e;
}

async function startRun(workflow: string, input: unknown = {}): Promise<string> {
  seq += 1;
  const id = `${workflow}-${seq}`;
  await engine.start(workflow, input, id);
  return id;
}

async function settle(id: string): Promise<void> {
  await engine.waitForRun(id).catch(() => undefined);
  await expect
    .poll(async () => (await engine.getRun(id))?.tags ?? [])
    .not.toContain('durable:lifecycle:pending');
}

async function waitStatus(id: string, status: string): Promise<void> {
  await expect.poll(async () => (await engine.getRun(id))?.status).toBe(status);
}

/** Run a command the way the kernel does (`exec`), in raw-output mode. */
async function exec(
  cls: CommandClass,
  argv: string[],
  prepare?: (command: BaseCommand) => void,
): Promise<{ exitCode: number; out: string; err: string; command: BaseCommand }> {
  ace.ui.logger.flushLogs();
  const command = await ace.create(cls, argv);
  prepare?.(command);
  await command.exec();
  const logs = command.logger.getLogs();
  const out = logs
    .filter((l) => l.stream === 'stdout')
    .map((l) => l.message)
    .join('\n');
  const err = logs
    .filter((l) => l.stream === 'stderr')
    .map((l) => l.message)
    .join('\n');
  if (command.error) throw command.error;
  return { exitCode: command.exitCode ?? 0, out, err, command };
}

/** The last stdout line block as JSON. */
function json(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

beforeAll(async () => {
  appRoot = await mkdtemp(join(tmpdir(), 'durable-cli-'));
  await writeFile(
    join(appRoot, 'adonisrc.ts'),
    `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
  );
  ace = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
    importer: (filePath) => import(filePath),
  });
  await ace.app.init();
  await ace.app.boot();
  ace.ui.switchMode('raw');
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

beforeEach(() => {
  engine = makeEngine();
  audits = [];
  ace.app.container.bindValue(WorkflowEngine, engine);
  ace.app.config.set('durable', {});
  ace.app.config.set('durable_dashboard', {
    audit: (entry: DashboardAuditEntry) => audits.push(entry),
  });
});

describe('command registration', () => {
  it('names every command <lib>:<noun>[:<verb>] and registers no duplicate', () => {
    const names = DURABLE_COMMANDS.map((c) => c.commandName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('durable:runs:retry');
    expect(names).not.toContain('durable:retry');
    for (const cls of DURABLE_COMMANDS) {
      // None of the console mirrors boots a worker or a server.
      if (cls.commandName === 'durable:work' || cls.commandName === 'durable:worker') continue;
      expect(cls.options.staysAlive ?? false).toBe(false);
    }
  });
});

describe('durable:runs', () => {
  it('lists runs through the console handler, with filters and a page footer', async () => {
    const ok = await startRun('greet', { name: 'a' });
    const bad = await startRun('boom');
    await settle(ok);
    await settle(bad);

    const all = await exec(DurableRuns, []);
    expect(all.out).toContain(ok);
    expect(all.out).toContain(bad);
    expect(all.out).toMatch(/page 1 of 1 \(2 total\)/);

    const failed = await exec(DurableRuns, ['--status', 'failed,dead']);
    expect(failed.out).toContain(bad);
    expect(failed.out).not.toContain(ok);
  });

  it('--json prints the { data, meta } page with the pending liveness', async () => {
    const id = await startRun('greet', { name: 'a' });
    await settle(id);
    const { out } = await exec(DurableRuns, ['--json', '--workflow', 'greet', '--size', '1']);
    const body = json(out);
    expect(body.meta).toMatchObject({ total: 1, perPage: 1, currentPage: 1 });
    expect((body.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      id,
      status: 'completed',
      pending: null,
    });
  });

  it('refuses a bad filter with exit code 1', async () => {
    const result = await exec(DurableRuns, ['--created-after', 'not-a-date']);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('--created-after is not a date');
  });

  it('refuses --tenant when tenancy is off', async () => {
    const result = await exec(DurableRuns, ['--tenant', 'org-1']);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('--tenant needs tenancy on');
  });

  it('--stale keeps only runs with an old pending remote step', async () => {
    const id = await startRun('greet', { name: 'a' });
    await settle(id);
    const { out } = await exec(DurableRuns, ['--stale']);
    expect(out).toBe('No runs.');
  });
});

describe('durable:runs:show / fan / values / event', () => {
  it('shows a run with its timeline, and --json is the console detail', async () => {
    const id = await startRun('greet', { name: 'ana' });
    await settle(id);
    const human = await exec(DurableRunsShow, [id]);
    expect(human.out).toContain('Status     completed');
    expect(human.out).toContain('hello');

    const { out } = await exec(DurableRunsShow, [id, '--json']);
    const body = json(out);
    expect((body.run as Record<string, unknown>).output).toBe('hello ana');
    expect(Array.isArray(body.timeline)).toBe(true);

    const field = await exec(DurableRunsShow, [id, '--field', 'run.output']);
    expect(JSON.parse(field.out)).toBe('hello ana');
  });

  it('exits 1 on an unknown run', async () => {
    const result = await exec(DurableRunsShow, ['nope']);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('run nope not found');
  });

  it('fan answers not-found for a run without that fan', async () => {
    const result = await exec(DurableRunsFan, ['nope', 'g1']);
    expect(result.exitCode).toBe(1);
  });

  it('counts runs by a field', async () => {
    await settle(await startRun('greet', { name: 'a' }));
    await settle(await startRun('greet', { name: 'b' }));
    const { out } = await exec(DurableRunsValues, ['workflow', '--json']);
    expect(json(out)).toEqual({ field: 'workflow', data: [{ value: 'greet', count: 2 }] });
    const bad = await exec(DurableRunsValues, ['color']);
    expect(bad.exitCode).toBe(1);
  });

  it('reads a value a run published', async () => {
    const id = await startRun('waiter');
    await waitStatus(id, 'suspended');
    const { out } = await exec(DurableRunsEvent, [id, 'progress']);
    expect(JSON.parse(out)).toEqual({ pct: 50 });
  });
});

describe('run actions', () => {
  it('retry re-enqueues a failed run and audits it as cli:<user>', async () => {
    const id = await startRun('boom');
    await settle(id);
    const result = await exec(DurableRunsRetry, [id, '--json']);
    expect(json(result.out)).toMatchObject({ result: { runId: id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ method: 'CLI', path: `durable:runs:retry ${id}` });
    expect(audits[0]?.actor).toMatch(/^cli(:.+)?$/);
  });

  it('retry exits 1 on an unknown run', async () => {
    const result = await exec(DurableRunsRetry, ['nope']);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('run nope not found');
  });

  it('cancel refuses without a terminal unless --force', async () => {
    const id = await startRun('waiter');
    await waitStatus(id, 'suspended');
    const refused = await exec(DurableRunsCancel, [id]);
    expect(refused.exitCode).toBe(1);
    expect(refused.err).toContain('pass --force');
    expect(audits).toHaveLength(0);
    expect((await engine.getRun(id))?.status).toBe('suspended');

    const done = await exec(DurableRunsCancel, [id, '--force', '--json']);
    expect(done.exitCode).toBe(0);
    expect(json(done.out)).toMatchObject({ result: { runId: id } });
    await waitStatus(id, 'cancelled');
  });

  it('cancel asks on a terminal, and a no aborts', async () => {
    const id = await startRun('waiter');
    await waitStatus(id, 'suspended');
    const declined = await exec(DurableRunsCancel, [id], (command) => {
      (command as unknown as { interactive: boolean }).interactive = true;
      command.prompt.trap('confirm').reject();
    });
    expect(declined.exitCode).toBe(1);
    expect(declined.err).toContain('Aborted');
    const accepted = await exec(DurableRunsCancel, [id], (command) => {
      (command as unknown as { interactive: boolean }).interactive = true;
      command.prompt.trap('confirm').accept();
    });
    expect(accepted.exitCode).toBe(0);
    await waitStatus(id, 'cancelled');
  });

  it('signal refuses a token the run is not waiting on, then delivers', async () => {
    const id = await startRun('waiter');
    await waitStatus(id, 'suspended');
    const wrong = await exec(DurableRunsSignal, [id, 'stop']);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.err).toContain('waiting on: go');

    const bad = await exec(DurableRunsSignal, [id, 'go', '--payload', '{nope']);
    expect(bad.exitCode).toBe(1);
    expect(bad.err).toContain('--payload must be valid JSON');

    await exec(DurableRunsSignal, [id, 'go', '--payload', '{"ok":true}']);
    await settle(id);
    expect((await engine.getRun(id))?.output).toEqual({ ok: true });
  });

  it('continue resumes a run at a breakpoint and refuses one that is not', async () => {
    const id = await startRun('pausable');
    await waitStatus(id, 'suspended');
    expect((await exec(DurableRunsContinue, [id])).exitCode).toBe(0);
    await settle(id);
    expect((await engine.getRun(id))?.output).toBe('resumed');
    expect((await exec(DurableRunsContinue, [id])).exitCode).toBe(1);
  });

  it('replay starts a fresh run with the corrected input, and needs --input', async () => {
    const id = await startRun('greet', { name: 'typo' });
    await settle(id);
    expect((await exec(DurableRunsReplay, [id])).exitCode).toBe(1);
    const { out } = await exec(DurableRunsReplay, [id, '--input', '{"name":"fixed"}', '--json']);
    const fresh = (json(out).result as { runId: string }).runId;
    await settle(fresh);
    expect((await engine.getRun(fresh))?.output).toBe('hello fixed');
  });

  it('redispatch needs --force without a terminal', async () => {
    const id = await startRun('greet', { name: 'a' });
    await settle(id);
    expect((await exec(DurableRunsRedispatch, [id])).exitCode).toBe(1);
    expect((await exec(DurableRunsRedispatch, [id, '--force'])).exitCode).toBe(0);
  });

  it('update and tasks complete / fail go through the console handlers', async () => {
    const up = await startRun('updatable');
    await waitStatus(up, 'suspended');
    const updated = await exec(DurableRunsUpdate, [up, 'bump', '--arg', '7', '--json']);
    expect(json(updated.out)).toMatchObject({ result: { accepted: true } });
    await settle(up);
    expect((await engine.getRun(up))?.output).toBe(7);

    const t1 = await startRun('tasker');
    await waitStatus(t1, 'suspended');
    const done = await exec(DurableTasksComplete, [t1, 'approve', '--result', '"yes"', '--json']);
    expect(json(done.out)).toMatchObject({ delivered: true });
    await settle(t1);
    expect((await engine.getRun(t1))?.output).toBe('yes');

    const t2 = await startRun('tasker');
    await waitStatus(t2, 'suspended');
    expect((await exec(DurableTasksFail, [t2, 'approve'])).exitCode).toBe(1);
    expect(
      (await exec(DurableTasksFail, [t2, 'approve', '--force', '--error', 'no'])).exitCode,
    ).toBe(0);
    await settle(t2);
    expect((await engine.getRun(t2))?.status).toBe('failed');
  });
});

describe('durable:runs:bulk', () => {
  it('--dry-run lists the matching runs and acts on none', async () => {
    const a = await startRun('boom');
    const b = await startRun('boom');
    await settle(a);
    await settle(b);
    const { out } = await exec(DurableRunsBulk, [
      'retry',
      '--status',
      'failed',
      '--dry-run',
      '--json',
    ]);
    const preview = json(out);
    expect(preview).toMatchObject({ action: 'retry', matched: 2, wouldApply: 2 });
    expect((preview.data as unknown[]).length).toBe(2);
    expect(audits).toHaveLength(0);
    expect((await engine.getRun(a))?.status).toBe('failed');
  });

  it('refuses without --force, then cancels every match', async () => {
    const a = await startRun('waiter');
    const b = await startRun('waiter');
    await waitStatus(a, 'suspended');
    await waitStatus(b, 'suspended');
    expect((await exec(DurableRunsBulk, ['cancel', '--workflow', 'waiter'])).exitCode).toBe(1);
    const { out } = await exec(DurableRunsBulk, [
      'cancel',
      '--workflow',
      'waiter',
      '--force',
      '--json',
    ]);
    expect(json(out)).toEqual({ matched: 2, applied: 2 });
    expect(audits).toHaveLength(1);
  });

  it('refuses an unknown action and --compensate with retry', async () => {
    expect((await exec(DurableRunsBulk, ['purge', '--force'])).exitCode).toBe(1);
    expect((await exec(DurableRunsBulk, ['retry', '--compensate', '--force'])).exitCode).toBe(1);
  });
});

describe('schedules', () => {
  beforeEach(() => {
    ace.app.config.set('durable', {
      schedules: [{ key: 'nightly', workflow: 'greet', input: { name: 'cron' }, everyMs: 60_000 }],
    });
  });

  it('lists the configured schedules (the set the worker ticks)', async () => {
    const human = await exec(DurableSchedules, []);
    expect(human.out).toContain('nightly');
    const { out } = await exec(DurableSchedules, ['--json']);
    const body = json(out);
    expect(body.meta).toMatchObject({ total: 1 });
    expect((body.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      key: 'nightly',
      paused: false,
    });
  });

  it('trigger fires the current window, idempotently', async () => {
    const first = json((await exec(DurableSchedulesTrigger, ['nightly', '--json'])).out);
    const second = json((await exec(DurableSchedulesTrigger, ['nightly', '--json'])).out);
    expect((first.result as { runId: string }).runId).toBe(
      (second.result as { runId: string }).runId,
    );
    expect((await exec(DurableSchedulesTrigger, ['missing'])).exitCode).toBe(1);
  });

  it('pause refuses without a control plane: it would reach no worker', async () => {
    const result = await exec(DurableSchedulesPause, ['nightly']);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('No control plane');
    expect(audits).toHaveLength(0);
  });

  it('pause / resume broadcast on the control plane before the command returns', async () => {
    const cp = new RecordingControlPlane();
    engine = makeEngine(cp);
    ace.app.container.bindValue(WorkflowEngine, engine);
    const paused = await exec(DurableSchedulesPause, ['nightly', '--json']);
    expect(json(paused.out)).toEqual({ key: 'nightly', paused: true });
    expect(cp.sent).toContainEqual(
      expect.objectContaining({ kind: 'schedulePause', key: 'nightly', paused: true }),
    );
    await exec(DurableSchedulesResume, ['nightly']);
    expect(cp.sent).toContainEqual(
      expect.objectContaining({ kind: 'schedulePause', paused: false }),
    );
    expect((await exec(DurableSchedulesPause, ['missing'])).exitCode).toBe(1);
  });
});

describe('workers / health / lifecycle', () => {
  it('workers and health answer the console shapes', async () => {
    const workers = json((await exec(DurableWorkers, ['--json'])).out);
    expect(Array.isArray(workers.data)).toBe(true);
    const health = await exec(DurableHealth, ['--json']);
    expect(json(health.out)).toMatchObject({ runs: { pending: 0, dead: 0, blocked: 0 } });
    expect(health.exitCode).toBe(0);
  });

  it('workflows:lifecycle lists the links', async () => {
    const { out } = await exec(DurableWorkflowsLifecycle, ['greet', '--json']);
    expect(json(out)).toMatchObject({ workflow: 'greet', startsOnSettle: [], startedBy: [] });
    const human = await exec(DurableWorkflowsLifecycle, ['greet']);
    expect(human.out).toContain('greet has no lifecycle links.');
  });

  it('lifecycle:republish refuses an unsettled run and bad flags', async () => {
    const id = await startRun('waiter');
    await waitStatus(id, 'suspended');
    const unsettled = await exec(DurableLifecycleRepublish, ['--run', id]);
    expect(unsettled.exitCode).toBe(1);
    expect(unsettled.err).toContain('has not settled');
    expect((await exec(DurableLifecycleRepublish, [])).exitCode).toBe(1);

    const done = await startRun('greet', { name: 'a' });
    await settle(done);
    const ok = await exec(DurableLifecycleRepublish, ['--run', done, '--json']);
    expect(ok.exitCode).toBe(0);
    expect(json(ok.out)).toMatchObject({ result: { runs: 1, failed: [] } });
  });
});

describe('--tenant with tenancy on', () => {
  const SLOT = Symbol.for('@agora/context:tenancy');
  const als = new AsyncLocalStorage<{ tenant?: { id: string; kind: string }; all?: boolean }>();
  const slot = {
    version: 1,
    tenancy: () => ({ enabled: true }),
    tenantFilter: () => {
      const store = als.getStore();
      if (!store) return { mode: 'system' };
      if (store.all) return { mode: 'all' };
      return store.tenant ? { mode: 'tenant', tenant: store.tenant } : { mode: 'tenantless' };
    },
    withTenant: <T>(input: { id: string; kind: string } | null, fn: () => T): T =>
      als.run(input ? { tenant: input } : {}, fn),
    allTenants: <T>(fn: () => T): T => als.run({ all: true }, fn),
  };

  beforeEach(async () => {
    (globalThis as Record<symbol, unknown>)[SLOT] = slot;
    engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
      tenancy: contextEngineTenancy(undefined),
    });
    engine.register('greet', '1', async () => 'hi');
    ace.app.container.bindValue(WorkflowEngine, engine);
    await engine.start('greet', {}, 'acme-1', { tenantId: 'acme', tenantKind: 'organization' });
    await engine.start('greet', {}, 'globex-1', { tenantId: 'globex', tenantKind: 'organization' });
    await settle('acme-1');
    await settle('globex-1');
  });
  afterAll(() => {
    delete (globalThis as Record<symbol, unknown>)[SLOT];
  });

  it('reads every tenant by default and one with --tenant', async () => {
    const ids = (out: string) => (json(out).data as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids((await exec(DurableRuns, ['--json'])).out)).toEqual(['acme-1', 'globex-1']);
    expect(ids((await exec(DurableRuns, ['--json', '--tenant', 'acme'])).out)).toEqual(['acme-1']);
  });

  it('an action on a run outside --tenant answers not found', async () => {
    const result = await exec(DurableRunsRetry, ['globex-1', '--tenant', 'acme']);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('run globex-1 not found');
  });
});

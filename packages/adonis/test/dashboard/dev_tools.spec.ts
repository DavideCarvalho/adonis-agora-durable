import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { anyAuthorize, authorizeByToken } from '../../src/dashboard/console_authorize.js';
import {
  type DevTool,
  type DevToolAuditEntry,
  type DevToolsLib,
  durableDevTools,
  registerDurableDevTools,
  truncateBlob,
} from '../../src/dashboard/dev_tools.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { type Deps, getRun, listRuns } from '../../src/dashboard/handlers.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

function makeEngine(redact?: Deps['redact']) {
  const raw = new WorkflowEngine({
    store: new InMemoryStateStore(),
    transport: new InMemoryTransport(),
  });
  raw.register('greet', '1', async (ctx, input) => {
    const { name } = input as { name: string };
    return ctx.localStep('hello', async () => `hello ${name}`);
  });
  raw.register('big', '1', async () => 'x'.repeat(10_000));
  raw.register('waiter', '1', async (ctx) => {
    await ctx.waitForSignal('go');
    return 'done';
  });
  const deps: Deps = { engine: storeDashboardEngine(raw), ...(redact ? { redact } : {}) };
  return { raw, deps };
}

/** Wait until the run settled AND its background lifecycle bookkeeping finished. */
async function settled(raw: WorkflowEngine, id: string): Promise<void> {
  await raw.waitForRun(id);
  await expect
    .poll(async () => (await raw.getRun(id))?.tags ?? [])
    .not.toContain('durable:lifecycle:pending');
}

let seq = 0;
async function start(raw: WorkflowEngine, workflow: string, input: unknown): Promise<string> {
  seq += 1;
  const id = `${workflow}-${seq}`;
  await raw.start(workflow, input, id);
  return id;
}

const call = { ctx: {} as HttpContext, caller: { id: 'token:abc', via: 'token' as const } };
const limits = { maxRows: 100, maxBytes: 48 * 1024 };

function tool(tools: DevTool[], name: string): DevTool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe('durable dev tools', () => {
  let raw: WorkflowEngine;
  let deps: Deps;
  let tools: DevTool[];
  let audits: DevToolAuditEntry[];

  beforeEach(() => {
    ({ raw, deps } = makeEngine());
    audits = [];
    tools = durableDevTools({ deps: async () => deps, audit: (e) => audits.push(e) });
  });

  it('names every tool with the durable_ prefix and a valid kind', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'durable_list_runs',
      'durable_get_run',
      'durable_list_fan_members',
      'durable_count_runs_by',
      'durable_get_health',
      'durable_list_workers',
      'durable_list_schedules',
      'durable_get_run_event',
      'durable_retry_run',
      'durable_cancel_run',
      'durable_continue_run',
      'durable_signal_run',
      'durable_trigger_schedule',
      'durable_pause_schedule',
    ]);
    for (const t of tools) {
      expect(t.name).toMatch(/^durable_[a-z]+_[a-z_]+$/);
      expect(t.input.type).toBe('object');
      for (const name of t.input.required ?? []) expect(t.input.properties).toHaveProperty(name);
    }
    expect(tools.filter((t) => t.kind === 'read')).toHaveLength(8);
    expect(tool(tools, 'durable_cancel_run').destructive).toBe(true);
  });

  it('durable_list_runs returns what GET /api/runs returns, as { items, next }', async () => {
    const id = await start(raw, 'greet', { name: 'ada' });
    await settled(raw, id);
    const viaTool = (await tool(tools, 'durable_list_runs').run({}, { ...call, limits })) as {
      items: unknown[];
      next: number | null;
    };
    const viaApi = await listRuns(deps, { params: {}, query: { page: '1', size: '20' } });
    expect(viaTool.items).toEqual((viaApi.body as { runs: unknown[] }).runs);
    expect(viaTool.next).toBeNull();
  });

  it('durable_list_runs pages with next and applies filters', async () => {
    for (let i = 0; i < 3; i += 1)
      await raw.waitForRun(await start(raw, 'greet', { name: `n${i}` }));
    await start(raw, 'waiter', {});
    const first = (await tool(tools, 'durable_list_runs').run(
      { limit: 2, workflow: 'greet' },
      { ...call, limits },
    )) as { items: Array<{ workflow: string }>; next: number | null };
    expect(first.items).toHaveLength(2);
    expect(first.items.every((r) => r.workflow === 'greet')).toBe(true);
    expect(first.next).toBe(2);
    const second = (await tool(tools, 'durable_list_runs').run(
      { limit: 2, workflow: 'greet', page: 2 },
      { ...call, limits },
    )) as { items: unknown[]; next: number | null };
    expect(second.items).toHaveLength(1);
    expect(second.next).toBeNull();
  });

  it('durable_get_run applies the console redact hooks', async () => {
    ({ raw, deps } = makeEngine({
      run: (r) => ({ ...r, input: '[hidden]' }),
      checkpoint: (c) => ({ ...c, output: '[hidden]' }),
    }));
    tools = durableDevTools({ deps: async () => deps });
    const id = await start(raw, 'greet', { name: 'secret-name' });
    await settled(raw, id);
    const detail = (await tool(tools, 'durable_get_run').run({ id }, { ...call, limits })) as {
      run: { input: unknown };
      timeline: Array<{ output: unknown }>;
    };
    expect(detail.run.input).toBe('[hidden]');
    expect(detail.timeline.every((c) => c.output === '[hidden]')).toBe(true);
    const viaApi = (await getRun(deps, { params: { id }, query: {} })).body as {
      run: unknown;
    };
    expect(detail.run).toEqual(viaApi.run);
  });

  it('durable_get_run cuts blobs to 4 KB and returns one field in full on request', async () => {
    const id = await start(raw, 'big', {});
    await raw.waitForRun(id);
    const detail = (await tool(tools, 'durable_get_run').run({ id }, { ...call, limits })) as {
      run: { output: string };
    };
    expect(detail.run.output).toMatch(/…\(truncated, \d+ bytes\)$/);
    expect(Buffer.byteLength(detail.run.output)).toBeLessThan(4200);
    const field = (await tool(tools, 'durable_get_run').run(
      { id, field: 'run.output' },
      { ...call, limits },
    )) as { value: string };
    expect(field.value).toBe('x'.repeat(10_000));
  });

  it('field never walks the prototype chain', async () => {
    const id = await start(raw, 'greet', { name: 'x' });
    await raw.waitForRun(id);
    for (const field of ['__proto__', 'constructor', 'run.constructor']) {
      await expect(
        tool(tools, 'durable_get_run').run({ id, field }, { ...call, limits }),
      ).rejects.toThrow(`has no field "${field}"`);
    }
  });

  it('answers a tool error for an unknown run', async () => {
    await expect(
      tool(tools, 'durable_get_run').run({ id: 'nope' }, { ...call, limits }),
    ).rejects.toThrow('run nope not found');
  });

  it('durable_count_runs_by counts one field', async () => {
    await raw.waitForRun(await start(raw, 'greet', { name: 'a' }));
    await raw.waitForRun(await start(raw, 'greet', { name: 'b' }));
    const out = (await tool(tools, 'durable_count_runs_by').run(
      { field: 'workflow' },
      { ...call, limits },
    )) as { field: string; values: Array<{ value: string; count: number }> };
    expect(out.field).toBe('workflow');
    expect(out.values).toContainEqual(expect.objectContaining({ value: 'greet', count: 2 }));
  });

  it('durable_get_health reports groups and run counts', async () => {
    const out = (await tool(tools, 'durable_get_health').run({}, { ...call, limits })) as {
      groups: unknown[];
      runs?: Record<string, number>;
    };
    expect(Array.isArray(out.groups)).toBe(true);
    expect(out.runs).toEqual({ pending: 0, dead: 0, blocked: 0 });
  });

  it('actions run the console handlers and are audited with the mcp: actor', async () => {
    const id = await start(raw, 'waiter', {});
    await expect.poll(async () => (await raw.getRun(id))?.status).toBe('suspended');
    await tool(tools, 'durable_signal_run').run(
      { id, token: 'go', payload: '{"ok":true}' },
      { ...call, limits },
    );
    await expect(raw.waitForRun(id)).resolves.toBeDefined();
    expect(audits).toEqual([{ actor: 'mcp:token:abc', tool: 'durable_signal_run', target: id }]);
  });

  it('refuses a signal payload that is not JSON', async () => {
    await expect(
      tool(tools, 'durable_signal_run').run(
        { id: 'r', token: 'go', payload: '{nope' },
        { ...call, limits },
      ),
    ).rejects.toThrow('payload must be valid JSON');
  });

  it('cancel passes compensate through', async () => {
    const id = await start(raw, 'waiter', {});
    await expect.poll(async () => (await raw.getRun(id))?.status).toBe('suspended');
    const out = (await tool(tools, 'durable_cancel_run').run({ id }, { ...call, limits })) as {
      result: { status: string };
    };
    expect(['cancelled', 'cancelling']).toContain(out.result.status);
  });

  it('hides tools the topology cannot run (available)', async () => {
    const bare = durableDevTools({
      deps: async () => {
        const { signal: _s, getEvent: _g, ...engine } = deps.engine;
        return { engine };
      },
    });
    expect(await tool(bare, 'durable_signal_run').available?.()).toBe(false);
    expect(await tool(bare, 'durable_get_run_event').available?.()).toBe(false);
    expect(await tool(tools, 'durable_signal_run').available?.()).toBe(true);
  });
});

describe('truncateBlob', () => {
  it('leaves small values alone and cuts big ones with the size', () => {
    expect(truncateBlob({ a: 1 })).toEqual({ a: 1 });
    expect(truncateBlob('é'.repeat(5000), 10)).toBe(`${'é'.repeat(5)}…(truncated, 10000 bytes)`);
  });
});

describe('registerDurableDevTools', () => {
  const authorize = async () => ({ allowed: true as const });
  const deps = async () => makeEngine().deps;

  it('skips without the hub binding', async () => {
    const container = { hasBinding: () => false, make: async () => undefined };
    expect(await registerDurableDevTools(container, { authorize, deps })).toBe(false);
  });

  it('skips a hub of another version', async () => {
    const container = {
      hasBinding: () => true,
      make: async () => ({ version: 2, register: () => undefined }),
    };
    expect(await registerDurableDevTools(container, { authorize, deps })).toBe(false);
  });

  it('registers into a v1 hub with the console authorize', async () => {
    const seen: DevToolsLib[] = [];
    const container = {
      hasBinding: (key: string) => key === 'agora.devTools',
      make: async () => ({ version: 1, register: (lib: DevToolsLib) => seen.push(lib) }),
    };
    expect(await registerDurableDevTools(container, { authorize, deps })).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.lib).toBe('durable');
    expect(seen[0]?.title).toBe('Durable workflows');
    expect(seen[0]?.authorize).toBe(authorize);
    expect(seen[0]?.tools).toHaveLength(14);
  });
});

describe('anyAuthorize', () => {
  const ctxWith = (authorization?: string) =>
    ({ request: { header: () => authorization } }) as unknown as HttpContext;

  it('allows when any authorizer allows', async () => {
    const gate = anyAuthorize(authorizeByToken({ token: 's3cret' }), () => false);
    expect(await gate(ctxWith('Bearer s3cret'))).toEqual({ allowed: true });
  });

  it('keeps the redirect of an unauthenticated authorizer', async () => {
    const gate = anyAuthorize(authorizeByToken({ token: 's3cret' }), () => ({
      redirectTo: '/login',
    }));
    expect(await gate(ctxWith())).toEqual({ redirectTo: '/login' });
  });

  it('is 401 when one said unauthenticated, 403 otherwise; a throw is skipped', async () => {
    const unauth = anyAuthorize(
      () => {
        throw new Error('boom');
      },
      authorizeByToken({ token: 's3cret' }),
    );
    expect(await unauth(ctxWith())).toEqual({ allowed: false, reason: 'unauthenticated' });
    const forbidden = anyAuthorize(() => false);
    expect(await forbidden(ctxWith())).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('rethrows an inner error when nobody allowed or asked to sign in', async () => {
    const boom = new Error('misconfigured');
    const gate = anyAuthorize(
      () => {
        throw boom;
      },
      () => false,
    );
    await expect(gate(ctxWith())).rejects.toBe(boom);
  });

  it('needs at least one authorizer', () => {
    expect(() => anyAuthorize()).toThrow('at least one');
  });
});

describe('DashboardProvider — dev tools registration', () => {
  let appRoot: string;
  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'durable-dev-tools-'));
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  async function boot(config: Record<string, unknown>, withHub: boolean) {
    const registered: DevToolsLib[] = [];
    class HubProvider {
      constructor(protected app: { container: { bindValue(k: string, v: unknown): void } }) {}
      register() {
        this.app.container.bindValue('agora.devTools', {
          version: 1,
          register: (lib: DevToolsLib) => registered.push(lib),
        });
      }
    }
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        config: { durable_dashboard: config },
        rcFileContents: {
          // The dashboard provider is listed FIRST: the hub exists anyway, since every register()
          // runs before any boot().
          providers: [
            () => import('../../providers/dashboard_provider.js'),
            ...(withHub ? [async () => ({ default: HubProvider })] : []),
          ],
        },
      })
      .create(pathToFileURL(`${appRoot}/`));
    const app = ignitor.createApp('web');
    await app.init();
    await app.boot();
    return registered;
  }

  it('registers the durable tools whatever the provider order', async () => {
    const registered = await boot({ authorize: () => true }, true);
    expect(registered.map((l) => l.lib)).toEqual(['durable']);
    expect(await registered[0]?.authorize({} as HttpContext)).toEqual({ allowed: true });
  });

  it('registers nothing when the console is disabled', async () => {
    expect(await boot({ enabled: false, authorize: () => true }, true)).toEqual([]);
  });

  it('a hub that throws does not break boot', async () => {
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        config: { durable_dashboard: { authorize: () => true } },
        rcFileContents: {
          providers: [
            async () => ({
              default: class {
                constructor(
                  protected app: { container: { bindValue(k: string, v: unknown): void } },
                ) {}
                register() {
                  this.app.container.bindValue('agora.devTools', {
                    version: 1,
                    register: () => {
                      throw new Error('hub exploded');
                    },
                  });
                }
              },
            }),
            () => import('../../providers/dashboard_provider.js'),
          ],
        },
      })
      .create(pathToFileURL(`${appRoot}/`));
    const app = ignitor.createApp('web');
    await app.init();
    await expect(app.boot()).resolves.toBeUndefined();
  });

  it('boots without the hub', async () => {
    expect(await boot({ authorize: () => true }, false)).toEqual([]);
  });
});

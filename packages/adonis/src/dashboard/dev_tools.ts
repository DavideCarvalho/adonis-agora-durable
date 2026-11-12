import type { HttpContext } from '@adonisjs/core/http';
import type { ConsoleDecision } from './console_authorize.js';
import {
  type ApiRequest,
  type ApiResponse,
  cancelRun,
  continueRun,
  type Deps,
  getFanMembers,
  getRun,
  getRunEvent,
  health,
  listRuns,
  listSchedules,
  retryRun,
  runValues,
  scheduleAction,
  signalRun,
  workers,
} from './handlers.js';
import { RUN_STATUSES } from './run-filter.js';

/*
 * The dev-tools registration contract, version 1, declared here STRUCTURALLY: the hub is bound at
 * `'agora.devTools'` by `@adonis-agora/agent/mcp_provider` when the app has it, and this package never
 * imports the agent (it stays an optional, undeclared peer). Same shapes as `@adonis-agora/agent/dev-tools`.
 */

/** The container binding the dev-tools hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

/** The hub a lib registers its developer tools into. */
export interface DevToolsHub {
  readonly version: 1;
  register(lib: DevToolsLib): void;
}

/** One lib's tools and the gate that decides who may use them. */
export interface DevToolsLib {
  lib: string;
  title: string;
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

/** What a lib's `authorize` answers: the console decision. */
export type DevToolsDecision = ConsoleDecision;

/** One developer tool. */
export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  ctx: HttpContext;
  caller: DevToolsCaller;
  limits: { maxRows: number; maxBytes: number };
}

/** Who is calling. Never a token value. */
export interface DevToolsCaller {
  id: string;
  via: 'token' | 'session' | 'open';
}

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/** One console action performed through a dev tool, for the console's audit sink. */
export interface DevToolAuditEntry {
  /** `mcp:<caller id>`. */
  actor: string;
  /** The tool name, e.g. `durable_cancel_run`. */
  tool: string;
  /** The run id or schedule key the action targets. */
  target: string;
}

/** What {@link durableDevTools} needs from the console. */
export interface DurableDevToolsOptions {
  /** The console's read/control port, resolved per call (the same `Deps` the console routes use). */
  deps: () => Promise<Deps>;
  /** Records an action (retry, cancel, …) before it runs, like a console POST. */
  audit?: (entry: DevToolAuditEntry) => void;
  /** The fleet compatibility panel's body, when the console can build it (`GET /api/compat`). */
  compat?: () => Promise<unknown>;
}

/** List tools default to this many rows. */
const DEFAULT_LIMIT = 20;
/** List tools return at most this many rows. */
const MAX_LIMIT = 100;
/** A blob field (run input/output/error, a step's input/output/error) is cut to this many bytes. */
export const DEV_TOOL_FIELD_BYTES = 4 * 1024;
const BLOB_FIELDS = ['input', 'output', 'error'] as const;

/** Thrown from a tool to answer an MCP error result (the agent turns it into `isError`). */
class DevToolError extends Error {}

/** Call a console handler with a synthetic request; any non-2xx answer becomes a tool error. */
async function call(
  handler: (deps: Deps, req: ApiRequest) => Promise<ApiResponse>,
  deps: Deps,
  req: Partial<ApiRequest>,
): Promise<unknown> {
  const response = await handler(deps, { params: {}, query: {}, ...req });
  if (response.status >= 200 && response.status < 300) return response.body;
  const body = response.body as { error?: unknown } | null;
  const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  throw new DevToolError(message);
}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) throw new DevToolError(`${key} is required`);
  return value;
}

function limitOf(input: Record<string, unknown>): number {
  const raw = input.limit;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** The run filters every listing tool shares, as the console's query string spells them. */
const RUN_FILTER_PROPERTIES: Record<string, DevToolInputProperty> = {
  status: {
    type: 'array',
    items: { type: 'string' },
    description: `Run statuses (any of): ${RUN_STATUSES.join(', ')}.`,
  },
  workflow: { type: 'string', description: 'Workflow name.' },
  tag: { type: 'string', description: 'A tag the run carries.' },
  namespace: { type: 'string', description: 'Worker namespace the run belongs to.' },
  createdAfter: { type: 'string', description: 'Only runs created at or after (ISO date).' },
  createdBefore: { type: 'string', description: 'Only runs created at or before (ISO date).' },
};

function runFilterQuery(input: Record<string, unknown>): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of Object.keys(RUN_FILTER_PROPERTIES)) {
    const value = input[key];
    if (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '') {
      query[key] = Array.isArray(value) ? value.map(String) : String(value);
    }
  }
  return query;
}

/** Cut one value to {@link DEV_TOOL_FIELD_BYTES} of JSON, ending with `…(truncated, N bytes)`. */
export function truncateBlob(value: unknown, maxBytes = DEV_TOOL_FIELD_BYTES): unknown {
  if (value === undefined || value === null) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return value;
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= maxBytes) return value;
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  // A cut through a multi-byte character leaves a replacement char: drop it.
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return `${cut}…(truncated, ${size} bytes)`;
}

function truncateBlobs(row: unknown): unknown {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of BLOB_FIELDS) if (key in out) out[key] = truncateBlob(out[key]);
  return out;
}

/** Read a dotted path (`run.input`, `timeline.2.output`) out of a run detail. */
function pick(body: unknown, path: string): unknown {
  let cursor: unknown = body;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Whether the port answers `method` (capability, not access). Errors resolving it hide the tool. */
function supports(options: DurableDevToolsOptions, method: string): () => Promise<boolean> {
  return async () => {
    try {
      const { engine } = await options.deps();
      return typeof (engine as unknown as Record<string, unknown>)[method] === 'function';
    } catch {
      return false;
    }
  };
}

function nextPage(page: number, returned: number, size: number): number | null {
  return returned >= size ? page + 1 : null;
}

/**
 * The durable console's developer tools: the same handlers (and so the same `redact` hooks) the
 * console's JSON API runs, under `durable_*` names. Reads are listed by default; the actions (retry,
 * cancel, continue, signal, schedule control) only when the app opts in on the dev endpoint.
 */
export function durableDevTools(options: DurableDevToolsOptions): DevTool[] {
  const audited = (tool: string, target: string, caller: DevToolsCaller) => {
    try {
      options.audit?.({ actor: `mcp:${caller.id}`, tool, target });
    } catch {
      /* auditing must never break the action */
    }
  };

  return [
    {
      name: 'durable_list_runs',
      kind: 'read',
      description:
        'List workflow runs, newest first, as the durable console shows them: id, workflow, status, namespace, tags, created/updated times, recovery attempts and what a suspended run is waiting on. Filters: status, workflow, tag, namespace, created range. Paged: pass `next` back as `page`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          ...RUN_FILTER_PROPERTIES,
          page: { type: 'integer', minimum: 1, description: '1-based page (default 1).' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LIMIT,
            description: 'Rows (default 20).',
          },
        },
      },
      run: async (input) => {
        const size = limitOf(input);
        const page = typeof input.page === 'number' && input.page >= 1 ? Math.trunc(input.page) : 1;
        const body = (await call(listRuns, await options.deps(), {
          query: { ...runFilterQuery(input), page: String(page), size: String(size) },
        })) as { runs: unknown[] };
        return { items: body.runs, next: nextPage(page, body.runs.length, size) };
      },
    },
    {
      name: 'durable_get_run',
      kind: 'read',
      description:
        "One run's detail: the run (input, output, error), its step timeline, children, summarized fans and lifecycle links. Input, output and error fields over 4 KB are cut; pass `field` (e.g. `run.input`, `timeline.3.output`) to read one in full. `full: true` lists every member of wide fans.",
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Run id.' },
          full: { type: 'boolean', description: 'Every fan member instead of fan summaries.' },
          field: {
            type: 'string',
            description:
              'A dotted path to return in full instead of the detail, e.g. `run.output`.',
          },
        },
        required: ['id'],
      },
      run: async (input) => {
        const id = required(input, 'id');
        const body = (await call(getRun, await options.deps(), {
          params: { id },
          query: input.full === true ? { full: 'true' } : {},
        })) as Record<string, unknown>;
        const field = str(input, 'field');
        if (field !== undefined) {
          const value = pick(body, field);
          if (value === undefined) throw new DevToolError(`run ${id} has no field "${field}"`);
          return { id, field, value };
        }
        const timeline = Array.isArray(body.timeline) ? body.timeline.map(truncateBlobs) : [];
        const fans = Array.isArray(body.fans)
          ? body.fans.map((fan: Record<string, unknown>) => ({
              ...fan,
              failures: Array.isArray(fan.failures) ? fan.failures.map(truncateBlobs) : [],
            }))
          : undefined;
        return {
          ...body,
          run: truncateBlobs(body.run),
          timeline,
          ...(fans ? { fans } : {}),
        };
      },
    },
    {
      name: 'durable_list_fan_members',
      kind: 'read',
      description:
        "One page of a wide fan's member steps (a fan `durable_get_run` summarized), in order. Paged by `offset`; returns { items, next, total }.",
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Run id.' },
          group: { type: 'string', description: 'The fan group, from the run detail `fans`.' },
          failed: { type: 'boolean', description: 'Only failed members.' },
          offset: { type: 'integer', minimum: 0, description: 'Members to skip (default 0).' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LIMIT,
            description: 'Rows (default 20).',
          },
        },
        required: ['id', 'group'],
      },
      run: async (input) => {
        const limit = limitOf(input);
        const offset =
          typeof input.offset === 'number' && input.offset >= 0 ? Math.trunc(input.offset) : 0;
        const body = (await call(getFanMembers, await options.deps(), {
          params: { id: required(input, 'id'), group: required(input, 'group') },
          query: {
            offset: String(offset),
            limit: String(limit),
            ...(input.failed === true ? { failed: 'true' } : {}),
          },
        })) as { items: unknown[]; total: number };
        const end = offset + body.items.length;
        return {
          items: body.items.map(truncateBlobs),
          next: end < body.total ? end : null,
          total: body.total,
        };
      },
    },
    {
      name: 'durable_count_runs_by',
      kind: 'read',
      description:
        "Count runs by one field (status, workflow, namespace, tag, `attr` for search-attribute keys, `attr.<key>` for one key's values) over the runs matching the filters. Returns { field, values: [{ value, count }] }.",
      input: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            description: 'status | workflow | namespace | tag | attr | attr.<key>',
          },
          ...RUN_FILTER_PROPERTIES,
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_LIMIT,
            description: 'Values (default 20).',
          },
        },
        required: ['field'],
      },
      run: async (input) => {
        const field = required(input, 'field');
        const values = await call(runValues, await options.deps(), {
          query: { ...runFilterQuery(input), field, limit: String(limitOf(input)) },
        });
        return { field, values };
      },
    },
    {
      name: 'durable_get_health',
      kind: 'read',
      description:
        'Fleet health: per worker group, the queue backlog and live workers (stalled = backlog with no worker), how many runs are pending, dead or blocked, and the protocol-compatibility panel when available.',
      input: { type: 'object', properties: {} },
      run: async () => {
        const deps = await options.deps();
        const groups = (await call(async (d) => health(d), deps, {})) as { groups: unknown[] };
        const counts: Record<string, number> = {};
        if (deps.engine.countRuns) {
          for (const status of ['pending', 'dead', 'blocked'] as const) {
            counts[status] = await deps.engine.countRuns({ status });
          }
        }
        let compatBody: unknown;
        if (options.compat) {
          try {
            compatBody = await options.compat();
          } catch {
            compatBody = undefined;
          }
        }
        return {
          groups: groups.groups,
          ...(Object.keys(counts).length > 0 ? { runs: counts } : {}),
          ...(compatBody !== undefined ? { compat: compatBody } : {}),
        };
      },
    },
    {
      name: 'durable_list_workers',
      kind: 'read',
      description:
        "Worker groups with every live worker's heartbeat (instance id, last beat, namespace) and the queue depth.",
      input: { type: 'object', properties: {} },
      run: async () => ({ items: await call(async (d) => workers(d), await options.deps(), {}) }),
    },
    {
      name: 'durable_list_schedules',
      kind: 'read',
      description:
        'Cron/interval schedules: key, workflow, cron or interval, paused (and whether by a runtime override), last and next fire, and the current window run status.',
      input: { type: 'object', properties: {} },
      available: supports(options, 'listSchedules'),
      run: async () => {
        const body = (await call(listSchedules, await options.deps(), {})) as {
          schedules: unknown[];
        };
        return { items: body.schedules, next: null };
      },
    },
    {
      name: 'durable_get_run_event',
      kind: 'read',
      description:
        'The latest value a run published for `key` with ctx.setEvent (a live query, no side effect). Cut to 4 KB.',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Run id.' },
          key: { type: 'string', description: 'The event key.' },
        },
        required: ['id', 'key'],
      },
      available: supports(options, 'getEvent'),
      run: async (input) => {
        const body = (await call(getRunEvent, await options.deps(), {
          params: { id: required(input, 'id'), key: required(input, 'key') },
        })) as Record<string, unknown>;
        return 'value' in body ? { ...body, value: truncateBlob(body.value) } : body;
      },
    },
    {
      name: 'durable_retry_run',
      kind: 'action',
      description:
        'Re-enqueue a failed or stuck run: completed steps replay from their checkpoints. Returns the run status after enqueueing.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Run id.' } },
        required: ['id'],
      },
      run: async (input, ctx) => {
        const id = required(input, 'id');
        audited('durable_retry_run', id, ctx.caller);
        return call(retryRun, await options.deps(), { params: { id } });
      },
    },
    {
      name: 'durable_cancel_run',
      kind: 'action',
      destructive: true,
      description:
        'Cancel a run. `compensate: true` also runs the saga undo of its completed steps. Returns the run status.',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Run id.' },
          compensate: { type: 'boolean', description: 'Run the compensations (saga undo).' },
        },
        required: ['id'],
      },
      run: async (input, ctx) => {
        const id = required(input, 'id');
        audited('durable_cancel_run', id, ctx.caller);
        return call(cancelRun, await options.deps(), {
          params: { id },
          body: { compensate: input.compensate === true },
        });
      },
    },
    {
      name: 'durable_continue_run',
      kind: 'action',
      description:
        'Resume a run paused at a ctx.breakpoint(). Errors when it is not paused at one.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Run id.' } },
        required: ['id'],
      },
      run: async (input, ctx) => {
        const id = required(input, 'id');
        audited('durable_continue_run', id, ctx.caller);
        return call(continueRun, await options.deps(), { params: { id } });
      },
    },
    {
      name: 'durable_signal_run',
      kind: 'action',
      description:
        'Deliver a signal to a run waiting on `token` (ctx.waitForSignal). `payload` is a JSON string. Refused when the run is not waiting on that token, unless `force: true`; the error lists the tokens it waits on.',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Run id.' },
          token: { type: 'string', description: 'The signal token the run waits on.' },
          payload: { type: 'string', description: 'The payload, as JSON (omit for none).' },
          force: { type: 'boolean', description: 'Buffer it even if the run is not waiting yet.' },
        },
        required: ['id', 'token'],
      },
      available: supports(options, 'signal'),
      run: async (input, ctx) => {
        const id = required(input, 'id');
        const token = required(input, 'token');
        let payload: unknown;
        const raw = str(input, 'payload');
        if (raw !== undefined) {
          try {
            payload = JSON.parse(raw);
          } catch {
            throw new DevToolError('payload must be valid JSON');
          }
        }
        audited('durable_signal_run', id, ctx.caller);
        return call(signalRun, await options.deps(), {
          params: { id },
          body: {
            token,
            ...(payload !== undefined ? { payload } : {}),
            force: input.force === true,
          },
        });
      },
    },
    {
      name: 'durable_trigger_schedule',
      kind: 'action',
      description:
        "Fire a schedule's current window now (idempotent: the window's run id is fixed). Returns the run status.",
      input: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Schedule key.' } },
        required: ['key'],
      },
      available: supports(options, 'triggerSchedule'),
      run: async (input, ctx) => {
        const key = required(input, 'key');
        audited('durable_trigger_schedule', key, ctx.caller);
        return call(scheduleAction, await options.deps(), { params: { key, action: 'trigger' } });
      },
    },
    {
      name: 'durable_pause_schedule',
      kind: 'action',
      description:
        'Pause a schedule fleet-wide (`paused: false` resumes it). A runtime override: the next deploy goes back to the config.',
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Schedule key.' },
          paused: { type: 'boolean', description: 'true pauses (default), false resumes.' },
        },
        required: ['key'],
      },
      available: supports(options, 'setSchedulePaused'),
      run: async (input, ctx) => {
        const key = required(input, 'key');
        const action = input.paused === false ? 'resume' : 'pause';
        audited('durable_pause_schedule', key, ctx.caller);
        return call(scheduleAction, await options.deps(), { params: { key, action } });
      },
    },
  ];
}

/**
 * Register the durable console's tools into the app's dev-tools hub, when one is bound (the app
 * registered `@adonis-agora/agent/mcp_provider`). Returns whether it registered.
 */
export async function registerDurableDevTools(
  container: {
    hasBinding(binding: string): boolean;
    make(binding: string): Promise<unknown>;
  },
  options: DurableDevToolsOptions & { authorize: (ctx: HttpContext) => Promise<DevToolsDecision> },
): Promise<boolean> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return false;
  const hub = (await container.make(DEV_TOOLS_BINDING)) as Partial<DevToolsHub> | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register({
    lib: 'durable',
    title: 'Durable workflows',
    authorize: options.authorize,
    tools: durableDevTools(options),
  });
  return true;
}

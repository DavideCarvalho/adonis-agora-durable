/**
 * Hand-written OpenAPI 3.1 document for the dashboard JSON API — served at `GET <path>/api/openapi.json`.
 *
 * Hand-written on purpose: the surface is ~20 routes and the wire contract is otherwise duplicated
 * as hand-typed clients (the SPA's `durable-client.ts` carries an explicit "shapes must stay frozen"
 * warning with nothing enforcing it). This document is the single machine-readable statement of that
 * contract — regenerate clients from it, diff it in CI, or import it into an API console. Update it
 * IN THE SAME CHANGE as any handler/response reshaping; `test/dashboard/openapi.spec.ts` asserts it
 * stays in sync with the registered routes.
 */

const runStatus = {
  type: 'string',
  enum: ['pending', 'running', 'suspended', 'blocked', 'completed', 'failed', 'cancelled', 'dead'],
} as const;

const runSummary = {
  type: 'object',
  description: "One run row of the list endpoint (the detail endpoint's `run` is a superset).",
  properties: {
    id: { type: 'string' },
    workflow: { type: 'string' },
    workflowVersion: { type: 'string' },
    status: runStatus,
    namespace: { type: 'string' },
    origin: { type: 'string', description: 'Package attribution; absent = unknown.' },
    tags: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    recoveryAttempts: { type: 'integer' },
    waiting: {
      type: 'object',
      description: 'What a suspended run is parked on (signal/webhook/child/breakpoint).',
    },
  },
  required: ['id', 'workflow', 'workflowVersion', 'status', 'createdAt', 'updatedAt'],
} as const;

const checkpoint = {
  type: 'object',
  description: "One step of a run's timeline.",
  properties: {
    seq: { type: 'integer' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['local', 'remote', 'sleep', 'signal'] },
    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
    attempts: { type: 'integer' },
    workerGroup: { type: 'string' },
    input: {},
    output: {},
    error: { type: 'object' },
    events: { type: 'array', items: { type: 'object' } },
    parallelGroup: { type: 'string' },
    enqueuedAt: { type: 'string', format: 'date-time' },
    startedAt: { type: 'string', format: 'date-time' },
    finishedAt: { type: 'string', format: 'date-time' },
    durationMs: { type: 'integer' },
    queueMs: { type: 'integer' },
  },
} as const;

const runResult = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    status: runStatus,
    output: {},
    error: { type: 'object' },
  },
  required: ['runId', 'status'],
} as const;

const errorBody = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
} as const;

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'The run id.',
} as const;

const nameParam = (what: string) =>
  ({
    name: 'name',
    in: 'path',
    required: true,
    schema: { type: 'string' },
    description: what,
  }) as const;

const jsonResponse = (description: string, schema: unknown) =>
  ({ description, content: { 'application/json': { schema } } }) as const;

const err = (description: string) =>
  jsonResponse(description, { $ref: '#/components/schemas/Error' });

/** Build the OpenAPI 3.1 document, with `servers` rooted at the mounted dashboard `apiBase`. */
export function openApiDocument(apiBase: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: '@adonis-agora/durable dashboard API',
      description:
        'The JSON control/read surface behind the durable workflow console. Mutating routes are ' +
        'guarded by the configured dashboard auth; every route returns application/json.',
      version: '1',
    },
    servers: [{ url: apiBase }],
    components: {
      schemas: {
        RunStatus: runStatus,
        RunSummary: runSummary,
        Checkpoint: checkpoint,
        RunResult: runResult,
        Error: errorBody,
      },
    },
    paths: {
      '/runs': {
        get: {
          summary: 'List runs (filtered, paginated)',
          description:
            'Filters ride the `filter[...]` envelope or flat params: status/statuses, workflow(s), ' +
            'tag(s), namespace(s), origin, createdAfter/createdBefore (epoch ms or ISO), and typed ' +
            'search-attribute predicates (`filter[attr.<key>][<op>]`).',
          parameters: [
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
            {
              name: 'size',
              in: 'query',
              schema: { type: 'integer', maximum: 200, default: 50 },
            },
          ],
          responses: {
            '200': jsonResponse('The page of runs.', {
              type: 'object',
              properties: {
                runs: { type: 'array', items: { $ref: '#/components/schemas/RunSummary' } },
                meta: { type: 'object' },
                statuses: { type: 'array', items: { type: 'string' } },
              },
            }),
            '400': err('An unreadable filter.'),
          },
        },
      },
      '/runs/values': {
        get: {
          summary: 'Distinct values of one filter axis, with counts (the pickers)',
          parameters: [
            {
              name: 'field',
              in: 'query',
              required: true,
              schema: {
                type: 'string',
                enum: [
                  'workflow',
                  'status',
                  'namespace',
                  'origin',
                  'tag',
                  'attributeKey',
                  'attributeValue',
                ],
              },
            },
            { name: 'key', in: 'query', schema: { type: 'string' } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': jsonResponse('Value rows.', { type: 'object' }) },
        },
      },
      '/runs/{id}': {
        get: {
          summary: "A run's detail: the run, its step timeline, its children",
          parameters: [idParam],
          responses: {
            '200': jsonResponse('Run detail.', {
              type: 'object',
              properties: {
                run: { $ref: '#/components/schemas/RunSummary' },
                timeline: { type: 'array', items: { $ref: '#/components/schemas/Checkpoint' } },
                children: { type: 'array', items: { type: 'string' } },
              },
            }),
            '404': err('Unknown run.'),
          },
        },
      },
      '/runs/{id}/stream': {
        get: {
          summary: "SSE live-tail of one run's lifecycle events",
          parameters: [idParam],
          responses: { '200': { description: 'text/event-stream of EngineEvents.' } },
        },
      },
      '/runs/{id}/retry': {
        post: {
          summary: 'Re-enqueue the run (replay + re-attempt the failed parts)',
          parameters: [idParam],
          responses: {
            '200': jsonResponse('Enqueued.', { type: 'object' }),
            '404': err('Unknown run.'),
          },
        },
      },
      '/runs/{id}/retry-with-input': {
        post: {
          summary: 'Fix-and-replay: start a fresh linked run with corrected input',
          parameters: [idParam],
          requestBody: {
            content: {
              'application/json': { schema: { type: 'object', properties: { input: {} } } },
            },
          },
          responses: {
            '200': jsonResponse('The new linked run id.', { type: 'object' }),
            '404': err('Unknown run, or unavailable on this topology.'),
          },
        },
      },
      '/runs/{id}/redispatch': {
        post: {
          summary: "Re-dispatch the run's lost pending remote steps",
          parameters: [idParam],
          responses: {
            '200': jsonResponse('Redispatched.', { type: 'object' }),
            '404': err('Unknown run.'),
          },
        },
      },
      '/runs/{id}/cancel': {
        post: {
          summary: 'Cancel the run (`?compensate=true` undoes its saga first)',
          parameters: [idParam, { name: 'compensate', in: 'query', schema: { type: 'boolean' } }],
          responses: {
            '200': jsonResponse('Cancelled.', { type: 'object' }),
            '404': err('Unknown run.'),
          },
        },
      },
      '/runs/{id}/continue': {
        post: {
          summary: 'Resume a run paused at a ctx.breakpoint()',
          parameters: [idParam],
          responses: {
            '200': jsonResponse('Resumed.', { type: 'object' }),
            '404': err('Not paused at a breakpoint, or unavailable on this topology.'),
          },
        },
      },
      '/runs/{id}/signal': {
        post: {
          summary: 'Deliver a signal payload on a token the run is waiting on',
          parameters: [idParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    token: { type: 'string' },
                    payload: {},
                    force: {
                      type: 'boolean',
                      description:
                        'Buffer even when the run is not currently waiting on the token.',
                    },
                  },
                  required: ['token'],
                },
              },
            },
          },
          responses: {
            '200': jsonResponse('Delivered.', {
              type: 'object',
              properties: { result: { $ref: '#/components/schemas/RunResult' } },
            }),
            '400': err('Missing token.'),
            '404': err('Unknown run, or unavailable on this topology.'),
            '409': err('The run is not waiting on that token (body lists `waitingOn`).'),
          },
        },
      },
      '/runs/{id}/update/{name}': {
        post: {
          summary: "Deliver a validated update to the run's ctx.onUpdate(name) point",
          parameters: [idParam, nameParam('The update name.')],
          requestBody: {
            content: {
              'application/json': { schema: { type: 'object', properties: { arg: {} } } },
            },
          },
          responses: {
            '200': jsonResponse('Accepted and delivered.', { type: 'object' }),
            '404': err('Unknown run, or unavailable on this topology.'),
            '422': err('Rejected by the registered validator (body carries the reason).'),
          },
        },
      },
      '/runs/{id}/tasks/{name}/complete': {
        post: {
          summary: 'Complete an external ctx.task (buffered when nothing waits yet)',
          parameters: [idParam, nameParam('The task name.')],
          requestBody: {
            content: {
              'application/json': { schema: { type: 'object', properties: { result: {} } } },
            },
          },
          responses: {
            '200': jsonResponse('`delivered` says live vs buffered.', { type: 'object' }),
          },
        },
      },
      '/runs/{id}/tasks/{name}/fail': {
        post: {
          summary: 'Fail an external ctx.task',
          parameters: [idParam, nameParam('The task name.')],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { error: { type: 'string' } } },
              },
            },
          },
          responses: {
            '200': jsonResponse('`delivered` says live vs buffered.', { type: 'object' }),
          },
        },
      },
      '/bulk/{action}': {
        post: {
          summary: 'Bulk retry/cancel every run matching a filter (capped at 500 per call)',
          parameters: [
            {
              name: 'action',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['retry', 'cancel'] },
            },
            { name: 'compensate', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: { '200': jsonResponse('`{ matched, applied }` counts.', { type: 'object' }) },
        },
      },
      '/schedules': {
        get: {
          summary: 'The ticked schedules with control state and fire windows',
          responses: {
            '200': jsonResponse('Schedule rows.', { type: 'object' }),
            '404': err('Unavailable on this topology.'),
          },
        },
      },
      '/schedules/{key}/{action}': {
        post: {
          summary: 'Pause / resume (runtime override) or trigger a schedule now',
          parameters: [
            { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'action',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['pause', 'resume', 'trigger'] },
            },
          ],
          responses: {
            '200': jsonResponse('Applied.', { type: 'object' }),
            '404': err('Unknown schedule, or unavailable on this topology.'),
          },
        },
      },
      '/health': {
        get: {
          summary: 'Worker-group health (compact)',
          responses: { '200': jsonResponse('Groups.', { type: 'object' }) },
        },
      },
      '/workers': {
        get: {
          summary: 'Worker-group health with full heartbeats (incl. WorkerStatus telemetry)',
          responses: { '200': jsonResponse('Groups + heartbeats.', { type: 'object' }) },
        },
      },
      '/topology': {
        get: {
          summary: "This deployment's durable role",
          responses: { '200': jsonResponse('`{ role, tenant? }`.', { type: 'object' }) },
        },
      },
      '/compat': {
        get: {
          summary: 'Fleet protocol-compatibility report + blocked runs',
          responses: { '200': jsonResponse('The compat report.', { type: 'object' }) },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'This document',
          responses: { '200': jsonResponse('The OpenAPI document.', { type: 'object' }) },
        },
      },
    },
  };
}

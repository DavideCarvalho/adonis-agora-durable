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
  enum: [
    'pending',
    'running',
    'suspended',
    'blocked',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'dead',
  ],
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
    origin: {
      type: 'string',
      description: "Package attribution; absent = the app's own workflow (no package origin).",
    },
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

/** The `meta` of an offset page (`@adonis-agora/filter`'s `offsetPage`). */
const offsetMeta = {
  type: 'object',
  properties: {
    total: { type: 'integer', description: 'Rows matching the request across every page.' },
    perPage: { type: 'integer' },
    currentPage: { type: 'integer' },
    lastPage: { type: 'integer' },
    firstPage: { type: 'integer' },
  },
  required: ['total', 'perPage', 'currentPage', 'lastPage', 'firstPage'],
} as const;

/** An offset page of `item`: `{ data, meta }`. */
const offsetPageOf = (item: unknown, extra: Record<string, unknown> = {}) =>
  ({
    type: 'object',
    properties: {
      data: { type: 'array', items: item },
      meta: { $ref: '#/components/schemas/OffsetMeta' },
      ...extra,
    },
    required: ['data', 'meta'],
  }) as const;

/** `page` / `size` query params with the endpoint's size policy. */
const pageParams = (defaultSize: number, maxSize: number) =>
  [
    {
      name: 'page',
      in: 'query',
      schema: { type: 'integer', minimum: 1, default: 1 },
      description: '1-based page number.',
    },
    {
      name: 'size',
      in: 'query',
      schema: { type: 'integer', minimum: 1, maximum: maxSize, default: defaultSize },
      description: `Page size, capped at ${maxSize}.`,
    },
  ] as const;

/** A `filter[<field>]` query param (deepObject: `filter[status]=failed`, `filter[tag][]=a`). */
const filterParam = (description: string) =>
  ({
    name: 'filter',
    in: 'query',
    style: 'deepObject',
    explode: true,
    schema: { type: 'object', additionalProperties: true },
    description,
  }) as const;

const sortParam = (description: string) =>
  ({ name: 'sort', in: 'query', schema: { type: 'string' }, description }) as const;

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'The run id.',
} as const;

/** The run-detail routes are versioned: a 200 carries an `ETag` when the store aggregates. */
const ifNoneMatchParam = {
  name: 'If-None-Match',
  in: 'header',
  schema: { type: 'string' },
  description:
    'The `ETag` of the response the client holds. Still current: a bodiless 304. Sent by the browser on its own, as the 200 is `Cache-Control: private, no-cache`.',
} as const;

const notModifiedResponse = {
  description: 'Unchanged since the `ETag` in `If-None-Match`. No body.',
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
        OffsetMeta: offsetMeta,
        Error: errorBody,
      },
    },
    paths: {
      '/runs': {
        get: {
          summary: 'List runs (filtered, newest first, offset-paged)',
          description:
            'Filters ride the `filter[...]` envelope: `status`, `workflow`, `tag`, `namespace` (one ' +
            'value or a set: `filter[tag][]=a&filter[tag][]=b`), `origin`, `createdAfter` / ' +
            '`createdBefore` (epoch ms or ISO), and search attributes (`filter[attr]=key:op:value`, ' +
            'or `filter[attr.<key>][<op>]=value`). An unknown field or operator, or a filter field ' +
            'sent bare (`?status=`), is a 400.',
          parameters: [
            filterParam('Run predicates (see the description).'),
            sortParam('`-createdAt` only (the default); anything else is a 400.'),
            ...pageParams(50, 200),
          ],
          responses: {
            '200': jsonResponse(
              'The page of runs, and every run status (`statuses`) for the chips.',
              offsetPageOf(
                { $ref: '#/components/schemas/RunSummary' },
                { statuses: { type: 'array', items: { $ref: '#/components/schemas/RunStatus' } } },
              ),
            ),
            '400': err('A refused filter or sort.'),
          },
        },
      },
      '/runs/values': {
        get: {
          summary: 'Distinct values of one filter axis, with counts (the pickers)',
          description:
            "The scope rides the same `filter[...]` envelope as `GET /runs` (minus `status`). This is filter's group-by-count aggregation, so it pages by `limit` / `offset`.",
          parameters: [
            {
              name: 'groupByCount[field]',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description:
                "`workflow`, `status`, `namespace`, `tag`, `attr` (attribute keys) or `attr.<key>` (one key's values). Top-level `field` works too.",
            },
            { name: 'groupByCount[search]', in: 'query', schema: { type: 'string' } },
            {
              name: 'groupByCount[limit]',
              in: 'query',
              schema: { type: 'integer', maximum: 200, default: 100 },
            },
            { name: 'groupByCount[offset]', in: 'query', schema: { type: 'integer', default: 0 } },
            filterParam('The scope, as on `GET /runs`.'),
          ],
          responses: {
            '200': jsonResponse('Value rows, most common first.', {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  value: { type: ['string', 'null'] },
                  count: { type: 'integer' },
                },
              },
            }),
            '400': err('A refused filter, or a field with no values.'),
          },
        },
      },
      '/runs/{id}': {
        get: {
          summary:
            "A run's detail: the run, its step timeline, its children. A fan with more than 50 members is summarized into `fans` unless `full=true`",
          parameters: [
            idParam,
            { name: 'full', in: 'query', schema: { type: 'boolean' } },
            ifNoneMatchParam,
          ],
          responses: {
            '200': jsonResponse('Run detail.', {
              type: 'object',
              properties: {
                run: { $ref: '#/components/schemas/RunSummary' },
                timeline: { type: 'array', items: { $ref: '#/components/schemas/Checkpoint' } },
                children: { type: 'array', items: { type: 'string' } },
                fans: { type: 'array', items: { type: 'object' } },
                childCount: { type: 'integer' },
                triggered: { type: 'array', items: { type: 'string' } },
                triggeredBy: { type: 'object' },
                lifecycleSubscribers: { type: 'array', items: { type: 'string' } },
                lifecycleDeliveries: { type: 'array', items: { type: 'object' } },
                waitsFor: { type: 'array', items: { type: 'object' } },
                awaitedBy: { type: 'array', items: { type: 'object' } },
                workflowLifecycle: { type: 'object' },
              },
            }),
            '304': notModifiedResponse,
            '404': err('Unknown run.'),
          },
        },
      },
      '/runs/{id}/fans/{group}': {
        get: {
          summary: "One page of a summarized fan's members, in seq order",
          parameters: [
            idParam,
            { name: 'group', in: 'path', required: true, schema: { type: 'string' } },
            filterParam('`filter[status]=failed` keeps the failed members only.'),
            sortParam('`seq` only (the default).'),
            ...pageParams(100, 500),
            ifNoneMatchParam,
          ],
          responses: {
            '304': notModifiedResponse,
            '200': jsonResponse(
              'A page of members.',
              offsetPageOf({ $ref: '#/components/schemas/Checkpoint' }),
            ),
            '400': err('A refused filter or sort.'),
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
      '/runs/{id}/republish-lifecycle': {
        post: {
          summary: "Publish a settled run's lifecycle event again (subscribers not started yet)",
          parameters: [idParam],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { subscriber: { type: 'string' } } },
              },
            },
          },
          responses: {
            '200': jsonResponse('Runs published, subscribers started, failures.', {
              type: 'object',
            }),
            '404': err('Unknown run, or unavailable on this topology.'),
            '409': err('The run has not settled.'),
            '501': err("The tenant pod's control plane is too old to answer it."),
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
      '/runs/{id}/updates/{name}': {
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
            filterParam('The runs to act on, as on `GET /runs`.'),
            {
              name: 'action',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['retry', 'cancel'] },
            },
            { name: 'compensate', in: 'query', schema: { type: 'boolean' } },
          ],
          responses: {
            '200': jsonResponse('`{ matched, applied }` counts.', { type: 'object' }),
            '400': err('A refused filter.'),
          },
        },
      },
      '/workflows/{name}/lifecycle': {
        get: {
          summary:
            'Who starts whom through lifecycle events: the workflows that start when it settles, and the ones that start it',
          parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': jsonResponse(
              '`{ workflow, startsOnSettle, startedBy }`, plus `triggerCounts` (per subscriber, started and failed, counted by this process) when the dashboard reads its metrics.',
              { type: 'object' },
            ),
            '404': err('Unavailable on this topology.'),
            '501': err("The tenant pod's control plane is too old to answer it."),
          },
        },
      },
      '/schedules': {
        get: {
          summary: 'The ticked schedules with control state and fire windows',
          parameters: [
            filterParam(
              '`filter[workflow]`, `filter[namespace]` (one or a set), `filter[paused]`.',
            ),
            sortParam(
              '`key` (default), `workflow`, `nextFireAt`, `lastFireAt`; `-` for descending.',
            ),
            ...pageParams(100, 200),
          ],
          responses: {
            '200': jsonResponse('A page of schedules.', offsetPageOf({ type: 'object' })),
            '400': err('A refused filter or sort.'),
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
          responses: {
            '200': jsonResponse(
              '`{ data }`: per group, `group`, `depth`, `liveWorkers`, `stalled`.',
              {
                type: 'object',
                properties: { data: { type: 'array', items: { type: 'object' } } },
                required: ['data'],
              },
            ),
          },
        },
      },
      '/runs/{id}/events/{key}': {
        get: {
          summary: 'The latest value the run published for `key` via ctx.setEvent',
          parameters: [
            idParam,
            {
              name: 'key',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'The event key.',
            },
          ],
          responses: {
            '200': jsonResponse('`{ value }`; `value` absent when never published.', {
              type: 'object',
            }),
            '404': err('Unknown run, or unavailable on this topology.'),
          },
        },
      },
      '/webhooks/{token}': {
        post: {
          summary: 'Deliver a ctx.webhook() callback; the body resumes the waiting run',
          parameters: [
            {
              name: 'token',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'The webhook token (`wh:<runId>:<seq>`).',
            },
          ],
          requestBody: { required: false, content: { 'application/json': { schema: {} } } },
          responses: {
            '200': jsonResponse('`{ result }` — the waiting run was resumed.', { type: 'object' }),
            '202': jsonResponse(
              '`{ buffered: true }` — the run is live but not waiting yet; its `wait()` consumes it.',
              { type: 'object' },
            ),
            '404': err('Not a webhook token, an unknown or terminal run, or already delivered.'),
            '413': err('Payload too large.'),
          },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus text exposition: event counters plus backlog and worker gauges',
          responses: {
            '200': {
              description: 'Prometheus text format 0.0.4.',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/workers': {
        get: {
          summary: 'Worker-group health with full heartbeats (incl. WorkerStatus telemetry)',
          responses: {
            '200': jsonResponse('`{ data }`: per group, its depth and live workers.', {
              type: 'object',
              properties: { data: { type: 'array', items: { type: 'object' } } },
              required: ['data'],
            }),
          },
        },
      },
      '/topology': {
        get: {
          summary: "This deployment's durable topology",
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

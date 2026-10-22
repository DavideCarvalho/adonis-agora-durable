import { describe, expect, it } from 'vitest';
import {
  gatewayDashboardEngine,
  storeDashboardEngine,
} from '../../src/dashboard/gateway-adapter.js';
import {
  type Deps,
  deliverWebhook,
  getRunEvent,
  metricsText,
} from '../../src/dashboard/handlers.js';
import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';
import { collectMetrics } from '../../src/metrics.js';
import type { RunGateway } from '../../src/run-gateway/interface.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';

/** `GET /metrics`, `GET /runs/:id/events/:key` and `POST /webhooks/:token`. */

function setup() {
  const store = new InMemoryStateStore();
  const raw = new WorkflowEngine({ store, transport: new InMemoryTransport() });
  raw.register('progress', '1', async (ctx) => {
    await ctx.setEvent('stage', { at: 'extract', secret: 's3cr3t' });
    await ctx.setEvent('stage', { at: 'load', secret: 's3cr3t' });
    await ctx.waitForSignal('never');
  });
  raw.register('hook', '1', async (ctx) => {
    const wh = ctx.webhook<{ paid: boolean }>();
    await ctx.setEvent('token', wh.token);
    return wh.wait();
  });
  raw.register('waiter', '1', async (ctx) => ctx.waitForSignal('go'));
  // Mints the webhook, publishes its token, then waits for a signal BEFORE wait(): a callback in
  // that window lands while nothing waits on the webhook yet.
  raw.register('late-hook', '1', async (ctx) => {
    const wh = ctx.webhook<{ paid: boolean }>();
    await ctx.setEvent('token', wh.token);
    await ctx.waitForSignal('continue');
    return wh.wait();
  });
  raw.register('ok', '1', async () => 'done');
  const deps: Deps = { engine: storeDashboardEngine(raw) };
  return { raw, deps, store };
}

const settle = () => new Promise((r) => setTimeout(r, 15));

describe('GET /runs/:id/events/:key', () => {
  it('returns the latest published value, {} for a key never published, 404 for an unknown run', async () => {
    const { raw, deps } = setup();
    await raw.start('progress', {}, 'p1');
    await settle();

    const res = await getRunEvent(deps, { params: { id: 'p1', key: 'stage' }, query: {} });
    expect(res).toEqual({ status: 200, body: { value: { at: 'load', secret: 's3cr3t' } } });
    expect(await getRunEvent(deps, { params: { id: 'p1', key: 'nope' }, query: {} })).toEqual({
      status: 200,
      body: {},
    });
    expect(
      (await getRunEvent(deps, { params: { id: 'zz', key: 'stage' }, query: {} })).status,
    ).toBe(404);
  });

  it('passes the value through the checkpoint redaction hook', async () => {
    const { raw, deps } = setup();
    await raw.start('progress', {}, 'p2');
    await settle();
    const redact = {
      checkpoint: (cp: Record<string, unknown>) => ({
        ...cp,
        output: { ...(cp.output as object), secret: '[redacted]' },
      }),
    };
    const res = await getRunEvent(
      { ...deps, redact },
      { params: { id: 'p2', key: 'stage' }, query: {} },
    );
    expect(res.body).toEqual({ value: { at: 'load', secret: '[redacted]' } });
  });

  it('is 404 on a tenant pod (no getEvent over the wire)', async () => {
    const { raw } = setup();
    const port = gatewayDashboardEngine(new StoreRunGateway(raw) as RunGateway);
    const res = await getRunEvent({ engine: port }, { params: { id: 'p', key: 'k' }, query: {} });
    expect(res.status).toBe(404);
  });
});

describe('POST /webhooks/:token', () => {
  it('resumes the run waiting on the webhook with the body', async () => {
    const { raw, deps } = setup();
    await raw.start('hook', {}, 'h1');
    await settle();
    const token = (await raw.getEvent<string>('h1', 'token')) as string;
    expect(token).toMatch(/^wh:h1:\d+$/);

    const res = await deliverWebhook(deps, { params: { token }, query: {}, body: { paid: true } });
    expect(res.status).toBe(200);
    expect((await raw.waitForRun('h1')).output).toEqual({ paid: true });

    // A duplicate callback finds nothing waiting: 404, nothing buffered.
    const again = await deliverWebhook(deps, { params: { token }, query: {}, body: {} });
    expect(again.status).toBe(404);
  });

  it('refuses a non-webhook token, so it is not a generic signal endpoint', async () => {
    const { raw, deps } = setup();
    await raw.start('waiter', {}, 'w1');
    await settle();
    const res = await deliverWebhook(deps, { params: { token: 'go' }, query: {}, body: 1 });
    expect(res.status).toBe(404);
    expect((await raw.getRun('w1'))?.status).toBe('suspended');
  });

  it('buffers an early callback for a live run, and the later wait() consumes it', async () => {
    const { raw, deps } = setup();
    await raw.start('late-hook', {}, 'h2');
    await settle();
    const token = (await raw.getEvent<string>('h2', 'token')) as string;

    // Nothing waits on the webhook yet (the run is parked on `continue`): buffered, 202.
    const early = await deliverWebhook(deps, {
      params: { token },
      query: {},
      body: { paid: true },
    });
    expect(early.status).toBe(202);
    expect(early.body).toEqual({ buffered: true });

    await raw.signal('continue', null);
    expect((await raw.waitForRun('h2')).output).toEqual({ paid: true });
    // Delivered once: a duplicate after the run settled is 404.
    const again = await deliverWebhook(deps, { params: { token }, query: {}, body: {} });
    expect(again.status).toBe(404);
  });

  it('a webhook token of an unknown or terminal run is 404 and buffers nothing', async () => {
    const { raw, deps, store } = setup();
    const unknown = await deliverWebhook(deps, {
      params: { token: 'wh:nobody:3' },
      query: {},
      body: 1,
    });
    expect(unknown.status).toBe(404);

    await raw.start('ok', {}, 'done1');
    await raw.waitForRun('done1');
    const terminal = await deliverWebhook(deps, {
      params: { token: 'wh:done1:0' },
      query: {},
      body: 1,
    });
    expect(terminal.status).toBe(404);
    // Nothing was buffered for either.
    expect(await store.takeBufferedSignal('wh:done1:0')).toBeFalsy();
    expect(await store.takeBufferedSignal('wh:nobody:3')).toBeFalsy();
  });
});

describe('GET /metrics', () => {
  it('serves the counters plus backlog and worker gauges', async () => {
    const { raw, deps } = setup();
    const collector = collectMetrics(raw);
    await raw.start('ok', {}, 'm1');
    await raw.waitForRun('m1');
    await raw.start('waiter', {}, 'm2');
    await settle();

    const text = await metricsText({ ...deps, metrics: collector });
    collector.stop();
    expect(text).toContain('durable_runs_total{event="completed"} 1');
    expect(text).toContain('# TYPE durable_pending_runs gauge');
    expect(text).toMatch(/durable_pending_runs \d+/);
    expect(text).toContain('durable_dead_runs 0');
  });

  it('per-group gauges escape label values', async () => {
    const deps: Deps = {
      engine: {
        workerHealth: async () => [{ group: 'a"b\\c', depth: 3, liveWorkers: [] }],
      } as unknown as Deps['engine'],
    };
    const text = await metricsText(deps);
    expect(text).toContain('durable_group_queue_depth{group="a\\"b\\\\c"} 3');
    expect(text).toContain('durable_group_live_workers{group="a\\"b\\\\c"} 0');
    expect(text).not.toContain('durable_pending_runs');
  });

  it('a tenant pod counts its backlog through runFacets; an old control plane drops the gauges', async () => {
    const { raw } = setup();
    await raw.start('waiter', {}, 't1');
    await settle();
    const gateway = new StoreRunGateway(raw);
    const text = await metricsText({ engine: gatewayDashboardEngine(gateway) });
    expect(text).toContain('durable_pending_runs 0');

    const old = new Proxy(gateway, {
      get(target, prop) {
        if (prop === 'runFacets') {
          return async () => {
            throw Object.assign(new Error('unknown'), { code: 'unsupported-request' });
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RunGateway;
    const degraded = await metricsText({ engine: gatewayDashboardEngine(old) });
    expect(degraded).not.toContain('durable_pending_runs');
  });

  it('counts only this instance’s events: another pod’s re-delivered events are not double-counted', async () => {
    const handlers: Array<(m: unknown) => void> = [];
    const controlPlane = {
      publishControl: async (msg: unknown) => {
        for (const h of handlers) h(JSON.parse(JSON.stringify(msg)));
      },
      onControl: (h: (m: unknown) => void) => void handlers.push(h),
    };
    const store = new InMemoryStateStore();
    const a = new WorkflowEngine({ store, controlPlane, instanceId: 'a' } as never);
    const b = new WorkflowEngine({ store, controlPlane, instanceId: 'b' } as never);
    a.register('ok', '1', async () => 'done');
    const ma = collectMetrics(a);
    const mb = collectMetrics(b);
    await a.start('ok', {}, 'x1');
    await a.waitForRun('x1');
    await settle();
    expect(ma.snapshot().runs.completed + mb.snapshot().runs.completed).toBe(1);
    ma.stop();
    mb.stop();
  });
});

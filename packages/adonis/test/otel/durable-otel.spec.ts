import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import type { WorkerDescriptor } from '../../src/handshake/descriptor.js';
import { FatalError, InMemoryStateStore, WorkflowEngine } from '../../src/index.js';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowRun,
  WorkflowStepEvent,
} from '../../src/interfaces.js';
import {
  LIFECYCLE_OWED_TAG_PREFIX,
  LIFECYCLE_PENDING_TAG,
  LIFECYCLE_TRACE_TAG_PREFIX,
  lifecycleRunId,
  runCompletedEvent,
} from '../../src/lifecycle-events.js';
import { attachDurableOtel } from '../../src/otel/durable-otel.js';

/** Build a full worker {@link WorkerDescriptor} for a token — the shape the transport advertises. */
function worker(partial: Partial<WorkerDescriptor> & { instanceId: string }): WorkerDescriptor {
  return {
    runtime: 'node',
    sdk: { name: 'test', version: '1' },
    protocol: { version: 1, range: [1, 1] },
    capabilities: [],
    workflows: [],
    steps: [],
    startedAt: 0,
    ...partial,
  };
}

/**
 * An in-process transport that ALSO advertises handshake descriptors per token, so the engine's
 * capability guard has a live fleet to consult — lets a test park a run `blocked` on purpose. Mirrors
 * `test/engine/capability-dispatch.spec.ts`'s `CapabilityTransport`.
 */
class CapabilityTransport implements Transport {
  descriptors: WorkerDescriptor[] = [];
  readonly dispatched: RemoteTask[] = [];
  private resultHandler?: (result: StepResult) => Promise<void>;
  private readonly handlers = new Map<string, (input: unknown) => unknown>();

  handle(name: string, fn: (input: unknown) => unknown): void {
    this.handlers.set(name, fn);
  }

  async dispatch(task: RemoteTask): Promise<void> {
    this.dispatched.push(task);
    const fn = this.handlers.get(task.name);
    const result: StepResult = fn
      ? {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'completed',
          output: fn(task.input),
        }
      : {
          runId: task.runId,
          seq: task.seq,
          stepId: task.stepId,
          status: 'completed',
          output: null,
        };
    setImmediate(() => void this.resultHandler?.(result));
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultHandler = handler;
  }

  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  onStepEvent(_handler: (event: WorkflowStepEvent) => Promise<void>): void {}

  async listWorkerDescriptors(_token: string): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
}

/** Drive deferred results/resumes until the run reaches a resting state (terminal OR blocked). */
async function settle(store: InMemoryStateStore, runId: string, max = 100) {
  for (let i = 0; i < max; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'pending' && run.status !== 'suspended') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

function tracerWithExporter() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter };
}

/** sdk-trace-base ^1.30 exposes the parent as `parentSpanId`; newer ones as `parentSpanContext`. */
function parentSpanId(span: ReadableSpan | undefined): string | undefined {
  return (
    (span as { parentSpanContext?: { spanId?: string } })?.parentSpanContext?.spanId ??
    (span as { parentSpanId?: string })?.parentSpanId
  );
}

describe('attachDurableOtel', () => {
  it('creates a trace per run and a child span per step', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });

    engine.register('checkout', '1', async (ctx) => {
      await ctx.localStep('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === 'workflow checkout');
    const step = spans.find((s) => s.name === 'step charge');
    expect(run).toBeDefined();
    expect(step).toBeDefined();
    expect(parentSpanId(step)).toBe(run?.spanContext().spanId);
    expect(run?.attributes['durable.run_id']).toBe('run1');
    expect(step?.attributes['durable.step.kind']).toBe('local');
  });

  it('marks the run span as error when the run fails', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });

    engine.register('wf', '1', async (ctx) =>
      ctx.localStep('boom', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');

    const run = exporter.getFinishedSpans().find((s) => s.name === 'workflow wf');
    expect(run?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('ends the root span (and drops it from the leak-prone roots Map) when a run parks BLOCKED on capability.unavailable', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const store = new InMemoryStateStore();
    const transport = new CapabilityTransport();
    transport.handle('billing.charge', () => ({ ok: true }));
    // A live worker exists but does NOT advertise the required 'saga' capability → the run blocks.
    transport.descriptors = [worker({ instanceId: 'w1', capabilities: ['signals'] })];

    const engine = new WorkflowEngine({ store, transport, blockedPollMs: 10 });
    attachDurableOtel(engine, { tracer });

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('billing.charge', { amount: 1 }, { requires: ['saga'] });
      return 'done';
    });

    await engine.start('checkout', {}, 'run1');
    const blocked = await settle(store, 'run1');
    expect(blocked.status).toBe('blocked');

    // Without the fix, `capability.unavailable` never closes the root: the span is never handed to the
    // exporter (it only ever sees `span.end()`ed spans), so this is the exact leak repro — the span
    // (and its `roots` Map entry) would otherwise stay open for the process's whole lifetime.
    const runSpans = exporter.getFinishedSpans().filter((s) => s.name === 'workflow checkout');
    expect(runSpans).toHaveLength(1);
    expect(runSpans[0]?.status.code).toBe(2); // SpanStatusCode.ERROR — a LOUD diagnostic, not success.

    // A capable worker joins the fleet; the blocked-recovery poll re-drives the run to completion.
    // Resuming a `blocked` run does NOT re-fire `run.started` (engine.ts only fires it from `pending`),
    // so no second root span is ever opened for this run — proving the Map entry was actually removed
    // (not merely re-used) and that `run.completed`'s `endRoot` call is a harmless no-op afterwards.
    transport.descriptors = [worker({ instanceId: 'w2', capabilities: ['saga'] })];
    await engine.resumeDueTimers(Date.now() + 1000);
    const completed = await settle(store, 'run1');
    expect(completed.status).toBe('completed');

    const runSpansAfterResume = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'workflow checkout');
    expect(runSpansAfterResume).toHaveLength(1);
  });

  it('marks the handoff to an onError handler on the run span', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });
    engine.register('dlq', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async () => {
        throw new FatalError('bad line', 'invalid_line');
      },
      { onError: [{ code: 'invalid_line', workflow: 'dlq' }] },
    );
    await engine.start('line', {}, 'r');
    await engine.waitForRun('r', { terminal: true });

    const run = exporter.getFinishedSpans().find((s) => s.name === 'workflow line');
    expect(run?.events.find((e) => e.name === 'durable.run.routed')?.attributes).toMatchObject({
      'durable.on_error.handler': 'dlq',
      'durable.error.code': 'invalid_line',
    });
  });

  it("links a lifecycle subscriber's run span to its source run's span", async () => {
    const { tracer, exporter } = tracerWithExporter();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    attachDurableOtel(engine, { tracer });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await engine.start('ingest', {}, 'i1');
    const subscriberId = lifecycleRunId('i1', 'completed', 'refresh');
    await engine.waitForRun(subscriberId);

    const spans = exporter.getFinishedSpans();
    const source = spans.find((s) => s.name === 'workflow ingest');
    const subscriber = spans.find((s) => s.name === 'workflow refresh');
    expect(subscriber?.attributes).toMatchObject({
      'durable.run_id': subscriberId,
      'durable.lifecycle.source_run_id': 'i1',
      'durable.lifecycle.kind': 'completed',
    });
    expect(subscriber?.links.map((l) => l.context.spanId)).toEqual([source?.spanContext().spanId]);
    expect(subscriber?.links[0]?.context.traceId).toBe(source?.spanContext().traceId);
    expect(source?.attributes['durable.lifecycle.source_run_id']).toBeUndefined();
    expect(source?.links).toEqual([]);
    // The source's span is recorded on the run, for a subscriber running in another process.
    const tags = (await store.getRun('i1'))?.tags ?? [];
    expect(tags).toContain(
      `${LIFECYCLE_TRACE_TAG_PREFIX}00-${source?.spanContext().traceId}-${source?.spanContext().spanId}-01`,
    );
  });

  it('links to the traceparent the source run recorded when it settled in another process', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const store = new InMemoryStateStore();
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    // Settled by another process, whose bridge recorded its span on the run.
    await store.createRun({
      id: 'i1',
      workflow: 'ingest',
      workflowVersion: '1',
      status: 'completed',
      input: {},
      output: 'ok',
      tags: [
        LIFECYCLE_PENDING_TAG,
        `${LIFECYCLE_OWED_TAG_PREFIX}refresh`,
        `${LIFECYCLE_TRACE_TAG_PREFIX}00-${traceId}-${spanId}-01`,
      ],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as WorkflowRun);
    const engine = new WorkflowEngine({ store });
    attachDurableOtel(engine, { tracer });
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.sweepLifecycleEvents(60_000);
    await engine.waitForRun(lifecycleRunId('i1', 'completed', 'refresh'));

    const subscriber = exporter.getFinishedSpans().find((s) => s.name === 'workflow refresh');
    expect(subscriber?.links.map((l) => l.context)).toEqual([
      expect.objectContaining({ traceId, spanId, traceFlags: 1, isRemote: true }),
    ]);
    expect(subscriber?.attributes['durable.lifecycle.source_run_id']).toBe('i1');
  });

  it('links to the span of the first turn when the run settles in a process that never saw it', async () => {
    const first = tracerWithExporter();
    const second = tracerWithExporter();
    const store = new InMemoryStateStore();
    const a = new WorkflowEngine({ store, instanceId: 'a' });
    const b = new WorkflowEngine({ store, instanceId: 'b' });
    attachDurableOtel(a, { tracer: first.tracer });
    attachDurableOtel(b, { tracer: second.tracer });
    for (const engine of [a, b]) {
      engine.register('ingest', '1', async (ctx) => ctx.waitForSignal('go'));
    }
    // The subscriber lives on B only; A learns of it from the registry.
    b.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await b.sweepLifecycleEvents();
    await a.sweepLifecycleEvents();

    await a.start('ingest', {}, 'i1');
    for (let i = 0; i < 200 && (await store.getRun('i1'))?.status !== 'suspended'; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect((await store.getRun('i1'))?.status).toBe('suspended');
    await b.signal('go', 'payload');
    const subscriberId = lifecycleRunId('i1', 'completed', 'refresh');
    await b.waitForRun(subscriberId);

    const source = first.exporter.getFinishedSpans().find((s) => s.name === 'workflow ingest');
    expect(second.exporter.getFinishedSpans().some((s) => s.name === 'workflow ingest')).toBe(
      false,
    );
    const subscriber = second.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'workflow refresh');
    expect(source).toBeDefined();
    expect(subscriber?.links.map((l) => l.context.spanId)).toEqual([source?.spanContext().spanId]);
    expect(subscriber?.links[0]?.context.traceId).toBe(source?.spanContext().traceId);
    expect(subscriber?.attributes['durable.lifecycle.source_run_id']).toBe('i1');
  });

  it('writes no trace tag for a run nobody subscribes to', async () => {
    const { tracer } = tracerWithExporter();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    attachDurableOtel(engine, { tracer });
    engine.register('ingest', '1', async () => 'ok');
    // Read the fleet's subscriptions first: before that read, a terminal write marks the run unresolved.
    await engine.sweepLifecycleEvents();
    let tagWrites = 0;
    const updateRun = store.updateRun.bind(store);
    store.updateRun = async (runId, patch) => {
      if (patch.tags) tagWrites += 1;
      return updateRun(runId, patch);
    };
    await engine.start('ingest', {}, 'i1');
    await engine.waitForRun('i1');
    expect(tagWrites).toBe(0);
    expect((await store.getRun('i1'))?.tags ?? []).toEqual([]);
  });

  it('stops answering run traceparents once detached', async () => {
    const { tracer } = tracerWithExporter();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const detach = attachDurableOtel(engine, { tracer });
    detach();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await engine.start('ingest', {}, 'i1');
    await engine.waitForRun(lifecycleRunId('i1', 'completed', 'refresh'));
    expect(
      (await store.getRun('i1'))?.tags?.some((t) => t.startsWith(LIFECYCLE_TRACE_TAG_PREFIX)),
    ).toBe(false);
  });
});

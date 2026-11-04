import {
  context,
  isSpanContextValid,
  type Link,
  type Span,
  type SpanContext,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';
import type { EngineEvent, WorkflowEngine } from '../index.js';
import { lifecycleSourceOf } from '../lifecycle-events.js';
import { isRemoteEvent } from '../remote-event.js';

/** How many runs' span contexts are kept after their span ended, for subscribers to link to. */
const ENDED_RUN_CONTEXTS = 10_000;

/** A span context as a W3C `traceparent`. */
function toTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${(ctx.traceFlags & 0xff).toString(16).padStart(2, '0')}`;
}

/** The span context a W3C `traceparent` names, or undefined when it is not a valid one. */
function fromTraceparent(traceparent: string | undefined): SpanContext | undefined {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(
    traceparent?.trim().toLowerCase() ?? '',
  );
  if (!match || match[1] === 'ff') return undefined;
  const ctx: SpanContext = {
    traceId: match[2] as string,
    spanId: match[3] as string,
    traceFlags: Number.parseInt(match[4] as string, 16),
    isRemote: true,
  };
  return isSpanContextValid(ctx) ? ctx : undefined;
}

export interface DurableOtelOptions {
  /** Tracer to use. Defaults to one from the global provider (or `provider` if given). */
  tracer?: Tracer;
  /** Tracer provider to take the tracer from. Defaults to the global OTel provider. */
  provider?: TracerProvider;
}

/**
 * Bridge engine lifecycle events to OpenTelemetry: one root span per run, one child span per step
 * (local/remote/sleep/signal), so a workflow shows up as a single distributed trace — including
 * remote steps once the worker continues the propagated `traceparent`. Returns an unsubscribe
 * function that detaches the bridge and ends any still-open root spans.
 *
 * Zero-overhead when no OTel SDK is registered: `@opentelemetry/api` resolves to no-op spans/tracer,
 * so the bridge still subscribes but produces nothing. Pair with {@link otelTraceparent} (wired into
 * the engine's `traceparent` option) for cross-process step continuation.
 *
 * A run a lifecycle event started (`@OnWorkflowCompleted`, `onEvent: [runCompletedEvent(...)]`) has
 * its root span linked to the source run's span, with `durable.lifecycle.source_run_id` and
 * `durable.lifecycle.kind` attributes. The bridge installs the engine's run trace provider
 * (`engine.setRunTraceparent`), so a run with subscribers records the traceparent of the span its
 * first turn opened (with its first suspend, or its terminal write), and the link holds when the
 * run settles, or the subscriber runs, in another process.
 */
export function attachDurableOtel(
  engine: WorkflowEngine,
  options: DurableOtelOptions = {},
): () => void {
  const tracer =
    options.tracer ?? (options.provider ?? trace).getTracer('@adonis-agora/durable', '0.1.0');
  const roots = new Map<string, Span>();
  const ended = new Map<string, SpanContext>();

  const remember = (runId: string, ctx: SpanContext): void => {
    ended.delete(runId);
    ended.set(runId, ctx);
    if (ended.size > ENDED_RUN_CONTEXTS) {
      const oldest = ended.keys().next().value;
      if (oldest !== undefined) ended.delete(oldest);
    }
  };
  const runTraceparent = (runId: string): string | undefined => {
    const ctx = roots.get(runId)?.spanContext() ?? ended.get(runId);
    return ctx && isSpanContextValid(ctx) ? toTraceparent(ctx) : undefined;
  };
  engine.setRunTraceparent(runTraceparent);

  const endRoot = (
    event: EngineEvent,
    status?: { error?: boolean | undefined; message?: string | undefined },
  ): void => {
    const span = roots.get(event.runId);
    if (!span) return;
    if (status?.error) {
      span.setStatus(
        status.message !== undefined
          ? { code: SpanStatusCode.ERROR, message: status.message }
          : { code: SpanStatusCode.ERROR },
      );
    }
    span.end(event.at);
    roots.delete(event.runId);
    remember(event.runId, span.spanContext());
  };

  const unsubscribe = engine.subscribe((event) => {
    // Spans come from the instance that ran the work; another instance's events, re-delivered here
    // over the control plane, would open a duplicate trace of the same run on every pod.
    if (isRemoteEvent(event)) return;
    switch (event.type) {
      case 'run.started': {
        const source =
          event.workflow !== undefined
            ? lifecycleSourceOf({ id: event.runId, workflow: event.workflow })
            : undefined;
        const sourceContext = source
          ? (fromTraceparent(event.sourceTraceparent) ??
            roots.get(source.runId)?.spanContext() ??
            ended.get(source.runId))
          : undefined;
        const links: Link[] = sourceContext ? [{ context: sourceContext }] : [];
        const span = tracer.startSpan(`workflow ${event.workflow ?? '?'}`, {
          startTime: event.at,
          attributes: {
            'durable.run_id': event.runId,
            'durable.workflow': event.workflow,
            ...(source
              ? {
                  'durable.lifecycle.source_run_id': source.runId,
                  'durable.lifecycle.kind': source.kind,
                }
              : {}),
          },
          links,
        });
        roots.set(event.runId, span);
        break;
      }
      case 'step.completed':
      case 'step.failed': {
        const parent = roots.get(event.runId);
        const ctx = parent ? trace.setSpan(context.active(), parent) : context.active();
        // Reconstruct the step's start from its end + duration so the span covers the real window.
        const startTime =
          event.durationMs != null ? event.at.getTime() - event.durationMs : event.at;
        const span = tracer.startSpan(
          `step ${event.name ?? '?'}`,
          {
            startTime,
            attributes: {
              'durable.run_id': event.runId,
              'durable.step.seq': event.seq,
              'durable.step.kind': event.kind,
            },
          },
          ctx,
        );
        if (event.type === 'step.failed') {
          const message = event.error?.message;
          span.setStatus(
            message !== undefined
              ? { code: SpanStatusCode.ERROR, message }
              : { code: SpanStatusCode.ERROR },
          );
        }
        span.end(event.at);
        break;
      }
      // Both are emitted while the run's span is still open: the handoff before the run suspends on its
      // handler, the unrouted failure before the run fails.
      case 'run.routed':
        roots.get(event.runId)?.addEvent(
          'durable.run.routed',
          {
            'durable.on_error.handler': event.name,
            'durable.error.code': event.error?.code,
            'durable.error.message': event.error?.message,
          },
          event.at,
        );
        break;
      case 'run.unrouted':
        roots.get(event.runId)?.addEvent(
          'durable.run.unrouted',
          {
            'durable.on_error.reason': event.reason,
            'durable.error.code': event.error?.code,
          },
          event.at,
        );
        break;
      case 'run.completed':
        endRoot(event);
        break;
      case 'run.suspended':
        // A suspended run is paused (waiting on a signal/timer/remote step), not finished — close the
        // root so the trace isn't left dangling; a later resume starts a fresh root on run.started.
        endRoot(event);
        break;
      case 'run.failed':
        endRoot(event, { error: true, message: event.error?.message });
        break;
      case 'capability.unavailable':
      case 'protocol.incompatible':
        // The run parked `blocked` (design §7.5/§7.6) — like a suspend, this is a resting state, not a
        // fresh execution, so the blocked-recovery poll's eventual resume does NOT re-emit `run.started`
        // (engine.ts only fires it from `pending`, and a blocked run resumes from `blocked`). Without
        // closing here, this root would NEVER see another lifecycle event — `run.completed`/`failed`/
        // `suspended` are the only other cases that end it — leaking the span (and this Map entry) for
        // as long as the process lives whenever a run blocks on a missing capability/protocol and either
        // never recovers or recovers on a leg with no further blocking. Mark it error: unlike a normal
        // suspend, this is the engine's LOUD diagnostic for a fleet that (at least momentarily) can't
        // serve the run.
        endRoot(event, { error: true, message: event.error?.message });
        break;
    }
  });
  return () => {
    unsubscribe();
    engine.setRunTraceparent(undefined);
  };
}

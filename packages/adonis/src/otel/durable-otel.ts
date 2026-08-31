import {
  context,
  type Span,
  SpanStatusCode,
  type Tracer,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';
import type { EngineEvent, WorkflowEngine } from '../index.js';

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
 */
export function attachDurableOtel(
  engine: WorkflowEngine,
  options: DurableOtelOptions = {},
): () => void {
  const tracer =
    options.tracer ?? (options.provider ?? trace).getTracer('@adonis-agora/durable', '0.1.0');
  const roots = new Map<string, Span>();

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
  };

  return engine.subscribe((event) => {
    switch (event.type) {
      case 'run.started': {
        const span = tracer.startSpan(`workflow ${event.workflow ?? '?'}`, {
          startTime: event.at,
          attributes: { 'durable.run_id': event.runId, 'durable.workflow': event.workflow },
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
    }
  });
}

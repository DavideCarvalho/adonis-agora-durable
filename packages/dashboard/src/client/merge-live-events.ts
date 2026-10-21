import type { RunDetail, StepEvent } from './durable-client.js';

/**
 * Merge a freshly-fetched run with the previously-cached one, preserving the live event trail the SSE
 * stream accumulated for in-flight steps.
 *
 * The store only persists a step's `events` at COMPLETION, so a poll/refetch returns a still-running
 * step with empty `events`. The live-tail (`step.progress`) appends events into the cache as they
 * arrive; replacing the cache wholesale on every 1.5s refetch would wipe that streamed trail — it
 * then reappears on the next stream event, so sub-processes flicker (appear → vanish → reappear).
 *
 * Rule: a step still `pending`/`running` with no fetched events keeps the streamed copy; a
 * `completed`/`failed` step is authoritative and always uses the fetched events (even if empty).
 */
export function mergeLiveEvents(prev: RunDetail | undefined, fresh: RunDetail): RunDetail {
  if (!prev) return fresh;
  const prevBySeq = new Map(prev.timeline.map((step) => [step.seq, step]));
  return {
    ...fresh,
    timeline: fresh.timeline.map((step) => {
      const inFlight = step.status === 'pending' || step.status === 'running';
      if (inFlight && (step.events?.length ?? 0) === 0) {
        const streamed = prevBySeq.get(step.seq)?.events;
        if (streamed?.length) return { ...step, events: streamed };
      }
      return step;
    }),
  };
}

/**
 * Append one streamed event to the cached step it belongs to. A step the detail does not list — a
 * member of a summarized fan — leaves the detail as it was (same identity, so nothing re-renders).
 */
export function appendLiveEvent(
  prev: RunDetail | undefined,
  seq: number,
  event: StepEvent,
): RunDetail | undefined {
  if (!prev) return prev;
  const index = prev.timeline.findIndex((step) => step.seq === seq);
  const step = prev.timeline[index];
  if (step === undefined) return prev;
  const timeline = [...prev.timeline];
  timeline[index] = { ...step, events: [...(step.events ?? []), event] };
  return { ...prev, timeline };
}

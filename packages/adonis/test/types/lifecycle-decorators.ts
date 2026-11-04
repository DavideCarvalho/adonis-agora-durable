/**
 * Compile-time guards for `@OnWorkflowCompleted` / `@OnWorkflowFailed` (checked by `tsc -p
 * tsconfig.tests.json`, no runtime assertions): with a class ref, the decorated workflow's `run`
 * input must accept the lifecycle event, or what `input` builds from it; `where` and `input` see
 * the source workflow's typed input and output. A string ref is not checked.
 */
import { BaseWorkflow } from '../../src/base-workflow.js';
import type { WorkflowCtx } from '../../src/interfaces.js';
import type { LifecycleEventOf } from '../../src/lifecycle-events.js';
import { OnWorkflowCompleted, OnWorkflowFailed } from '../../src/workflow-events.js';

class IngestWorkflow extends BaseWorkflow {
  static override workflow = { name: 'type-test-ingest' };
  async run(_ctx: WorkflowCtx, input: { baseId: string; type: string }): Promise<{ rows: number }> {
    return { rows: input.baseId.length };
  }
}

// Positive: the subscriber takes the typed event, and `where` reads the source's input and output.
@OnWorkflowCompleted(IngestWorkflow, {
  where: (e) => e.input.type === 'mvr' && (e.output?.rows ?? 0) > 0,
})
class TakesEvent extends BaseWorkflow {
  static override workflow = { name: 'type-test-takes-event' };
  async run(_ctx: WorkflowCtx, event: LifecycleEventOf<typeof IngestWorkflow>) {
    return event.input.baseId;
  }
}

// Positive: `input` maps the event to the subscriber's own input shape.
@OnWorkflowCompleted(IngestWorkflow, { input: (e) => ({ baseId: e.input.baseId }) })
class TakesMapped extends BaseWorkflow {
  static override workflow = { name: 'type-test-takes-mapped' };
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Negative: without `input`, a subscriber expecting another shape does not compile.
// @ts-expect-error run's input is not the lifecycle event
@OnWorkflowCompleted(IngestWorkflow)
class WrongShape extends BaseWorkflow {
  static override workflow = { name: 'type-test-wrong-shape' };
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Negative: `input`'s result must match the subscriber's input.
// @ts-expect-error run expects a number where `input` builds a string
@OnWorkflowFailed(IngestWorkflow, {
  statuses: ['failed', 'dead'],
  input: (e) => ({ baseId: e.input.baseId }),
})
class WrongMapped extends BaseWorkflow {
  static override workflow = { name: 'type-test-wrong-mapped' };
  async run(_ctx: WorkflowCtx, input: { baseId: number }) {
    return input.baseId;
  }
}

// A string ref carries no types, so it does not constrain the subscriber.
@OnWorkflowFailed('type-test-ingest')
class ByName extends BaseWorkflow {
  static override workflow = { name: 'type-test-by-name' };
  async run(_ctx: WorkflowCtx, input: { anything: true }) {
    return input;
  }
}

// Positive: a debounce `key` receives the subscriber's input (what `input` builds).
@OnWorkflowCompleted(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  debounce: { windowMs: '30s', key: (input) => input.baseId },
})
class KeyedDebounce extends BaseWorkflow {
  static override workflow = { name: 'type-test-keyed-debounce' };
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Negative: the key only sees the subscriber's input, not the lifecycle event.
@OnWorkflowCompleted(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  // @ts-expect-error `type` is on the source run's input, not on the subscriber's input
  debounce: { windowMs: 1000, key: (input) => input.type },
})
class KeyOnWrongShape extends BaseWorkflow {
  static override workflow = { name: 'type-test-key-wrong-shape' };
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Positive: with `batch`, the subscriber receives `{ events }` of its input, keyed the same way.
@OnWorkflowFailed(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  batch: { maxSize: 10, windowMs: '1m', key: (input) => input.baseId },
})
class Batched extends BaseWorkflow {
  static override workflow = { name: 'type-test-batched' };
  async run(_ctx: WorkflowCtx, input: { events: { baseId: string }[] }) {
    return input.events.length;
  }
}

// Negative: a batched subscriber does not receive a single input.
// @ts-expect-error run must take `{ events }` when the subscription batches
@OnWorkflowCompleted(IngestWorkflow, {
  input: (e) => ({ baseId: e.input.baseId }),
  batch: { maxSize: 10, windowMs: 1000 },
})
class BatchedWrongShape extends BaseWorkflow {
  static override workflow = { name: 'type-test-batched-wrong' };
  async run(_ctx: WorkflowCtx, input: { baseId: string }) {
    return input.baseId;
  }
}

// Negative: debounce and batch cannot be combined.
// @ts-expect-error pass debounce or batch, not both
@OnWorkflowCompleted(IngestWorkflow, {
  debounce: { windowMs: 1000 },
  batch: { maxSize: 10, windowMs: 1000 },
})
class Both extends BaseWorkflow {
  static override workflow = { name: 'type-test-both' };
  async run(_ctx: WorkflowCtx, input: { events: LifecycleEventOf<typeof IngestWorkflow>[] }) {
    return input;
  }
}

// `ctx.waitForRun` with a class ref types the event by the run's workflow; by id it is unknown.
async function waits(ctx: WorkflowCtx) {
  const typed = await ctx.waitForRun(IngestWorkflow, 'run-1', { timeoutMs: '1h' });
  const rows: number | undefined = typed.output?.rows;
  const baseId: string = typed.input.baseId;
  // @ts-expect-error the output has no `missing`
  void typed.output?.missing;
  const loose = await ctx.waitForRun<{ n: number }>('run-2');
  const n: number | undefined = loose.output?.n;
  // @ts-expect-error by id the input is unknown
  void loose.input.baseId;
  return [rows, baseId, n];
}

void [
  TakesEvent,
  TakesMapped,
  WrongShape,
  WrongMapped,
  ByName,
  KeyedDebounce,
  KeyOnWrongShape,
  Batched,
  BatchedWrongShape,
  Both,
  waits,
];

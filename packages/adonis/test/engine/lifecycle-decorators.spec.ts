import { describe, expect, it } from 'vitest';
import { BaseWorkflow } from '../../src/base-workflow.js';
import { WorkflowEngine } from '../../src/engine.js';
import { FatalError } from '../../src/errors.js';
import type { WorkflowCtx } from '../../src/interfaces.js';
import type { LifecycleEventOf, WorkflowLifecycleEvent } from '../../src/lifecycle-events.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { registerWorkflowClass } from '../../src/workflow-discovery.js';
import { OnEvent, OnWorkflowCompleted, OnWorkflowFailed } from '../../src/workflow-events.js';

interface IngestInput {
  table: string;
  fail?: boolean;
  park?: boolean;
}

const seen: Record<string, WorkflowLifecycleEvent[]> = { mvr: [], failed: [] };

class IngestWorkflow extends BaseWorkflow {
  static override workflow = { name: 'ingest' };
  async run(ctx: WorkflowCtx, input: IngestInput): Promise<{ rows: number }> {
    await ctx.upsertSearchAttributes({ table: input.table });
    if (input.fail) throw new FatalError('bad file', 'bad_file');
    if (input.park) await ctx.waitForSignal('never');
    return { rows: 2 };
  }
}

@OnWorkflowCompleted(IngestWorkflow, { where: (e) => e.input.table === 'mvr' })
class MvrSummariesWorkflow extends BaseWorkflow {
  static override workflow = { name: 'mvr-summaries' };
  async run(_ctx: WorkflowCtx, event: LifecycleEventOf<typeof IngestWorkflow>) {
    seen.mvr?.push(event);
    return event.output?.rows;
  }
}

@OnWorkflowFailed('ingest')
class IngestAlertWorkflow extends BaseWorkflow {
  static override workflow = { name: 'ingest-alert' };
  async run(_ctx: WorkflowCtx, event: WorkflowLifecycleEvent) {
    seen.failed?.push(event);
  }
}

@OnWorkflowCompleted(IngestWorkflow, {
  where: (e) => e.input.table === 'mvr',
  input: (e) => ({ table: e.input.table, rows: e.output?.rows ?? 0 }),
})
class MvrRefreshWorkflow extends BaseWorkflow {
  static override workflow = { name: 'mvr-refresh' };
  async run(_ctx: WorkflowCtx, input: { table: string; rows: number }) {
    return input;
  }
}

@OnWorkflowFailed(IngestWorkflow, { statuses: ['failed', 'dead'] })
class FailurePagerWorkflow extends BaseWorkflow {
  static override workflow = { name: 'failure-pager' };
  async run(_ctx: WorkflowCtx, event: LifecycleEventOf<typeof IngestWorkflow>) {
    return event.status;
  }
}

async function boot() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  for (const cls of [
    IngestWorkflow,
    MvrSummariesWorkflow,
    IngestAlertWorkflow,
    MvrRefreshWorkflow,
    FailurePagerWorkflow,
  ]) {
    await registerWorkflowClass(engine, cls);
  }
  return { store, engine };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('@OnWorkflowCompleted / @OnWorkflowFailed', () => {
  it('starts the subscriber on completion, filtered by where, with the settled run as input', async () => {
    const { store, engine } = await boot();

    await engine.start(IngestWorkflow, { table: 'mel' }, 'mel-1');
    await engine.start(IngestWorkflow, { table: 'mvr' }, 'mvr-1');
    await engine.waitForRun('mvr-1');
    await engine.waitForRun('evt:mvr-1:completed:mvr-summaries');
    await settle();

    expect((await store.getRun('evt:mvr-1:completed:mvr-summaries'))?.output).toBe(2);
    expect(await store.getRun('evt:mel-1:completed:mvr-summaries')).toBeNull();
    expect(seen.mvr?.[0]).toMatchObject({
      runId: 'mvr-1',
      input: { table: 'mvr' },
      searchAttributes: { table: 'mvr' },
    });
  });

  it('starts the failed-subscriber, by string name, when the run fails', async () => {
    const { engine } = await boot();

    await engine.start(IngestWorkflow, { table: 'mvr', fail: true }, 'bad-1');
    await engine.waitForRun('evt:bad-1:failed:ingest-alert');

    expect(seen.failed?.[0]).toMatchObject({ runId: 'bad-1', status: 'failed' });
  });

  it('stamps the subscription on static workflow.onEvent, keeping existing entries', () => {
    @OnWorkflowCompleted('ingest')
    @OnEvent({ event: 'agora:other' })
    class Both extends BaseWorkflow {
      static override workflow = { name: 'both', onEvent: ['plain.event'] };
      async run() {}
    }
    expect(Both.workflow.onEvent).toEqual([{ event: 'run.completed:ingest' }, 'plain.event']);
    expect(IngestWorkflow.workflow).not.toHaveProperty('onEvent');
  });
});

describe('lifecycle decorator options', () => {
  it('starts the subscriber with what input builds from the event', async () => {
    const { store, engine } = await boot();

    await engine.start(IngestWorkflow, { table: 'mvr' }, 'mvr-2');
    await engine.waitForRun('evt:mvr-2:completed:mvr-refresh');

    expect((await store.getRun('evt:mvr-2:completed:mvr-refresh'))?.input).toEqual({
      table: 'mvr',
      rows: 2,
    });
  });

  it('starts a failed-subscriber only for the statuses it asked for', async () => {
    const { store, engine } = await boot();

    await engine.start(IngestWorkflow, { table: 'mvr', fail: true }, 'bad-2');
    await engine.waitForRun('evt:bad-2:failed:failure-pager');
    expect((await store.getRun('evt:bad-2:failed:failure-pager'))?.output).toBe('failed');

    await engine.start(IngestWorkflow, { table: 'mvr', park: true }, 'cancel-me');
    await engine.waitForRun('cancel-me');
    await engine.cancel('cancel-me');
    await engine.waitForRun('evt:cancel-me:failed:ingest-alert');
    await settle();
    expect(await store.getRun('evt:cancel-me:failed:failure-pager')).toBeNull();
  });
});

describe('@OnWorkflowCompleted misuse', () => {
  it('fails at decoration with the workflow-name error for an undecorated source', () => {
    class NotAWorkflow {
      async run() {}
    }
    expect(() => OnWorkflowCompleted(NotAWorkflow)).toThrow(/has no registered name/);
  });

  it('fails at decoration on a subscriber without static workflow', () => {
    expect(() => {
      @OnWorkflowCompleted('ingest')
      class NoConfig {
        async run() {}
      }
      return NoConfig;
    }).toThrow(/declares no `static workflow/);
  });
});

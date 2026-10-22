import { describe, expect, it, vi } from 'vitest';
import { BaseWorkflow } from '../../src/base-workflow.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { DeadLetter, WorkflowCtx, WorkflowRun } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { registerWorkflowClass } from '../../src/workflow-discovery.js';

/**
 * Declarative dead-lettering: a run that goes `dead` (past `maxRecoveryAttempts`) is handed to a
 * dead-letter workflow — the engine-wide `deadLetterWorkflow`, a workflow's own option, or an inline
 * `deadLetter()` method on a `BaseWorkflow` — started as `dlq:<deadRunId>`.
 */

const crashed = (id: string, over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: 'pipeline',
  workflowVersion: '1',
  status: 'running', // a crashed executor left it running with a free lease
  input: { file: `${id}.csv` },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

async function until(check: () => Promise<boolean>, max = 400): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

function engineWith(deps: Partial<ConstructorParameters<typeof WorkflowEngine>[0]> = {}) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, maxRecoveryAttempts: 0, ...deps });
  const handled: Array<{ handler: string; runId: string; input: DeadLetter }> = [];
  const handler = (name: string) => async (ctx: WorkflowCtx, input: unknown) => {
    handled.push({ handler: name, runId: ctx.runId, input: input as DeadLetter });
    return 'handled';
  };
  engine.register('pipeline', '1', async () => 'never runs here');
  engine.register('global-dlq', '1', handler('global-dlq'));
  engine.register('pipeline-dlq', '1', handler('pipeline-dlq'));
  return { store, engine, handled, handler };
}

describe('deadLetterWorkflow', () => {
  it('starts the engine-wide default with the dead run, as dlq:<id> in its namespace', async () => {
    const { store, engine, handled } = engineWith({ deadLetterWorkflow: 'global-dlq' });
    await store.createRun(crashed('r1', { namespace: 'acme' }));

    await engine.recoverIncomplete();
    expect((await store.getRun('r1'))?.status).toBe('dead');
    await until(async () => (await store.getRun('dlq:r1'))?.status === 'completed');

    expect(handled).toEqual([
      {
        handler: 'global-dlq',
        runId: 'dlq:r1',
        input: {
          deadRunId: 'r1',
          workflow: 'pipeline',
          input: { file: 'r1.csv' },
          error: expect.objectContaining({ code: 'max_recovery_attempts' }),
        },
      },
    ]);
    expect((await store.getRun('dlq:r1'))?.namespace).toBe('acme');
  });

  it('a workflow’s own deadLetterWorkflow wins over the default', async () => {
    const { store, engine, handled } = engineWith({ deadLetterWorkflow: 'global-dlq' });
    engine.register('pipeline', '2', async () => 'x', { deadLetterWorkflow: 'pipeline-dlq' });
    await store.createRun(crashed('r2', { workflowVersion: '2' }));
    await engine.recoverIncomplete();
    await until(async () => (await store.getRun('dlq:r2'))?.status === 'completed');
    expect(handled.map((h) => h.handler)).toEqual(['pipeline-dlq']);
  });

  it('is idempotent by dlq:<id>, and a dying handler run is not routed again', async () => {
    const { store, engine, handled } = engineWith({ deadLetterWorkflow: 'global-dlq' });
    await store.createRun(crashed('r3'));
    await engine.recoverIncomplete();
    await until(async () => (await store.getRun('dlq:r3'))?.status === 'completed');

    // Dead-lettered again (requeued, crashed again): still one handler run.
    await store.updateRun('r3', { status: 'running', updatedAt: new Date() });
    await engine.recoverIncomplete();
    await new Promise((r) => setTimeout(r, 20));
    expect(handled).toHaveLength(1);

    // A handler run that itself dies is left dead: no dlq:dlq:… chain.
    await store.createRun(crashed('dlq:other', { workflow: 'global-dlq' }));
    await engine.recoverIncomplete();
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.getRun('dlq:dlq:other')).toBeNull();
  });

  it('nothing configured: a dead run starts nothing; an unknown handler is warned, not thrown', async () => {
    const plain = engineWith();
    await plain.store.createRun(crashed('r4'));
    await plain.engine.recoverIncomplete();
    expect((await plain.store.getRun('r4'))?.status).toBe('dead');
    expect(await plain.store.getRun('dlq:r4')).toBeNull();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const missing = engineWith({ deadLetterWorkflow: 'nope' });
      await missing.store.createRun(crashed('r5'));
      await missing.engine.recoverIncomplete();
      await until(async () => warn.mock.calls.some((c) => String(c[0]).includes('nope')));
      expect((await missing.store.getRun('r5'))?.status).toBe('dead');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('an inline deadLetter() method on a BaseWorkflow', () => {
  it('registers <name>.dlq and routes the workflow’s dead runs to it', async () => {
    const seen: DeadLetter[] = [];
    class Pipeline extends BaseWorkflow {
      static override workflow = { name: 'pipeline', version: '1' };
      readonly alerts = seen; // an injected service, shared with the handler
      override async run() {
        return 'ok';
      }
      override async deadLetter(_ctx: WorkflowCtx, dead: DeadLetter) {
        this.alerts.push(dead);
        return 'paged';
      }
    }
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({
      store,
      maxRecoveryAttempts: 0,
      deadLetterWorkflow: 'global-dlq',
    });
    await registerWorkflowClass(engine, Pipeline);
    await store.createRun(crashed('r1'));
    await engine.recoverIncomplete();
    await until(async () => (await store.getRun('dlq:r1'))?.status === 'completed');
    expect((await store.getRun('dlq:r1'))?.workflow).toBe('pipeline.dlq');
    expect(seen.map((d) => d.deadRunId)).toEqual(['r1']);
  });

  it('declaring both the method and deadLetterWorkflow throws at registration', async () => {
    class Both extends BaseWorkflow {
      static override workflow = { name: 'both', version: '1', deadLetterWorkflow: 'global-dlq' };
      override async run() {
        return 'ok';
      }
      override async deadLetter() {
        return 'x';
      }
    }
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    await expect(registerWorkflowClass(engine, Both)).rejects.toThrow(
      /both declares both a deadLetter\(\) method and a deadLetterWorkflow/,
    );
  });
});

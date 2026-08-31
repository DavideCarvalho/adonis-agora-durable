import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import defaultHook, {
  GENERATED_WORKFLOWS_OUTPUT,
  workflowsHook,
} from '../../src/hooks/workflows.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { registerWorkflowsFromBarrel, type WorkflowsBarrel } from '../../src/workflow-discovery.js';

/** A minimal stand-in for the Assembler IndexGenerator: records the `add(name, config)` calls. */
function fakeIndexGenerator() {
  const calls: Array<{ name: string; config: Record<string, unknown> }> = [];
  return {
    calls,
    generator: {
      add(name: string, config: Record<string, unknown>) {
        calls.push({ name, config });
        return this;
      },
    },
  };
}

describe('workflows assembler init hook', () => {
  it('the module loads and the default export is a runnable hook (smoke)', () => {
    expect(typeof defaultHook.run).toBe('function');
    expect(GENERATED_WORKFLOWS_OUTPUT).toBe('.adonisjs/durable/workflows.ts');
  });

  it('registers a `workflows` barrelFile source with the expected defaults', () => {
    const fake = fakeIndexGenerator();
    // run(parent, hooks, indexGenerator) — only the third arg matters here.
    defaultHook.run(undefined, undefined, fake.generator as never);

    expect(fake.calls).toHaveLength(1);
    const { name, config } = fake.calls[0]!;
    expect(name).toBe('workflows');
    expect(config).toMatchObject({
      source: 'app/workflows',
      as: 'barrelFile',
      exportName: 'workflows',
      importAlias: '#workflows',
      removeSuffix: 'workflow',
      output: '.adonisjs/durable/workflows.ts',
    });
  });

  it('honours custom source / importAlias / output options', () => {
    const fake = fakeIndexGenerator();
    workflowsHook({
      source: 'app/flows',
      importAlias: '#flows',
      output: '.adonisjs/custom/flows.ts',
    }).run(undefined, undefined, fake.generator as never);

    expect(fake.calls[0]?.config).toMatchObject({
      source: 'app/flows',
      importAlias: '#flows',
      output: '.adonisjs/custom/flows.ts',
    });
  });
});

describe('registerWorkflowsFromBarrel (provider consumes the generated barrel)', () => {
  it('registers every workflow class reachable from a lazy barrel and runs it', async () => {
    class Greet {
      static workflow = { name: 'greet' };
      async run(_ctx: unknown, input: { name: string }) {
        return `hi ${input.name}`;
      }
    }

    // Shape matches the generated barrel: stable key → lazy module import.
    const barrel: WorkflowsBarrel = {
      Greet: async () => ({ default: Greet }),
    };

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const meta = await registerWorkflowsFromBarrel(engine, barrel);

    expect(meta).toEqual([{ name: 'greet', version: '1' }]);

    const run = await startRun(engine, 'greet', { name: 'ada' }, 'r1');
    expect(run.status).toBe('completed');
    expect(run.output).toBe('hi ada');
  });

  it('dedupes a class re-exported under several keys/modules (registers once)', async () => {
    class Once {
      static workflow = { name: 'once' };
      async run() {
        return 'ok';
      }
    }

    const barrel: WorkflowsBarrel = {
      A: async () => ({ default: Once }),
      B: async () => ({ Once }),
    };

    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const meta = await registerWorkflowsFromBarrel(engine, barrel);
    expect(meta).toEqual([{ name: 'once', version: '1' }]);
  });

  it('ignores non-workflow exports in a barrel module', async () => {
    class NotAWorkflow {}
    const barrel: WorkflowsBarrel = {
      X: async () => ({ default: NotAWorkflow, helper: () => 1 }),
    };
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const meta = await registerWorkflowsFromBarrel(engine, barrel);
    expect(meta).toEqual([]);
  });
});

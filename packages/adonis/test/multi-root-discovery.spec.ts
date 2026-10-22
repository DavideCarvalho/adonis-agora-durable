import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateDiscoveryError } from '../src/discovery-roots.js';
import { WorkflowEngine } from '../src/engine.js';
import type { StepHandler } from '../src/protocol.js';
import {
  registerStepsFromBarrel,
  registerStepsFromDir,
  type StepServer,
} from '../src/step-discovery.js';
import { InMemoryStateStore } from '../src/testing/in-memory-state-store.js';
import { InMemoryTransport } from '../src/testing/in-memory-transport.js';
import {
  discoverWorkflows,
  registerWorkflowsFromBarrel,
  registerWorkflowsFromDir,
} from '../src/workflow-discovery.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const workflowModule = (cls: string, name: string, version = '1', tag = cls) =>
  `import { BaseWorkflow } from '${SRC}/base-workflow.js'
   export default class ${cls} extends BaseWorkflow {
     static workflow = { name: '${name}', version: '${version}' }
     async run(_ctx, input) { return '${tag}:' + input }
   }`;

const stepModule = (name: string, tag: string) =>
  `import { defineStep } from '${SRC}/step-ref.js'
   export const step = defineStep('${name}', async (input) => '${tag}:' + input)`;

class FakeStepServer implements StepServer {
  readonly handlers = new Map<string, StepHandler>();
  handle(name: string, fn: StepHandler): void {
    this.handlers.set(name, fn);
  }
}

const noopLog = {} as never;

let root: string;
const write = async (rel: string, contents: string) => {
  const file = join(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
};
const dir = (rel: string) => join(root, rel);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'durable-multi-root-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workflow discovery over several roots', () => {
  it('scans every root, in order, nested directories included', async () => {
    await write('orders/flows/place_workflow.ts', workflowModule('Place', 'place'));
    await write('billing/flows/deep/charge_workflow.ts', workflowModule('Charge', 'charge'));

    const found = await discoverWorkflows([dir('orders/flows'), dir('billing/flows')]);
    expect(found.map((f) => f.meta.name)).toEqual(['place', 'charge']);
    expect(found[1]?.file).toBe(dir('billing/flows/deep/charge_workflow.ts'));
  });

  it('registers workflows from every root and runs them', async () => {
    await write('a/one_workflow.ts', workflowModule('One', 'one'));
    await write('b/two_workflow.ts', workflowModule('Two', 'two'));
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });

    const meta = await registerWorkflowsFromDir(engine, [dir('a'), dir('b')]);
    expect(meta.map((m) => m.name)).toEqual(['one', 'two']);
    await engine.start('two', 'x', 'r2');
    expect((await engine.waitForRun('r2')).output).toBe('Two:x');
  });

  it('throws on the same name + version in two roots, quoting both files, registering nothing', async () => {
    const first = await write('orders/charge_workflow.ts', workflowModule('A', 'charge'));
    const second = await write('billing/charge_workflow.ts', workflowModule('B', 'charge'));
    await write('billing/other_workflow.ts', workflowModule('Other', 'other'));
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });

    const err = await registerWorkflowsFromDir(engine, [dir('orders'), dir('billing')]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DuplicateDiscoveryError);
    expect((err as Error).message).toContain('workflow "charge" (version 1)');
    expect((err as Error).message).toContain(first);
    expect((err as Error).message).toContain(second);
    await expect(engine.start('other', 'x', 'r')).rejects.toThrow();
  });

  it('allows the same name with a different version in another root', async () => {
    await write('v1/charge_workflow.ts', workflowModule('V1', 'charge', '1'));
    await write('v2/charge_workflow.ts', workflowModule('V2', 'charge', '2'));
    const found = await discoverWorkflows([dir('v1'), dir('v2')]);
    expect(found.map((f) => f.meta)).toEqual([
      { name: 'charge', version: '1' },
      { name: 'charge', version: '2' },
    ]);
  });

  it('a class reachable from two roots (a re-export, or overlapping roots) registers once', async () => {
    await write('core/place_workflow.ts', workflowModule('Place', 'place'));
    await write('facade/index.ts', `export { default as Place } from '../core/place_workflow.ts'`);
    // Overlapping roots too: `root` contains `core`.
    const found = await discoverWorkflows([dir('core'), dir('facade'), root]);
    expect(found.map((f) => f.meta.name)).toEqual(['place']);
  });

  it('keeps the single-root behaviour for a duplicate inside ONE root (no throw)', async () => {
    await write('one/a_workflow.ts', workflowModule('A', 'dup'));
    await write('one/b_workflow.ts', workflowModule('B', 'dup'));
    await expect(discoverWorkflows(dir('one'))).resolves.toHaveLength(2);
    await expect(discoverWorkflows([dir('one')])).resolves.toHaveLength(2);
  });
});

describe('step discovery over several roots', () => {
  it('serves the steps of every root', async () => {
    await write('orders/steps/reserve_step.ts', stepModule('reserve', 'orders'));
    await write('billing/steps/charge_step.ts', stepModule('charge', 'billing'));
    const server = new FakeStepServer();

    const meta = await registerStepsFromDir(server, [dir('orders/steps'), dir('billing/steps')]);
    expect(meta.map((m) => m.name)).toEqual(['reserve', 'charge']);
    expect(await server.handlers.get('charge')?.('5', noopLog)).toBe('billing:5');
  });

  it('throws on a step name served from two roots, quoting both files, serving nothing', async () => {
    const first = await write('a/charge_step.ts', stepModule('charge', 'a'));
    await write('a/refund_step.ts', stepModule('refund', 'a'));
    const second = await write('b/charge_step.ts', stepModule('charge', 'b'));
    const server = new FakeStepServer();

    const err = await registerStepsFromDir(server, [dir('a'), dir('b')]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DuplicateDiscoveryError);
    expect((err as Error).message).toContain('step "charge"');
    expect((err as Error).message).toContain(first);
    expect((err as Error).message).toContain(second);
    expect(server.handlers.size).toBe(0);
  });

  it('a handler re-exported from another root is served once, without throwing', async () => {
    await write('core/charge_step.ts', stepModule('charge', 'core'));
    await write('facade/index.ts', `export { step } from '../core/charge_step.ts'`);
    const server = new FakeStepServer();
    const meta = await registerStepsFromDir(server, [dir('core'), dir('facade')]);
    expect(meta.map((m) => m.name)).toEqual(['charge']);
  });

  it('keeps the single-root behaviour for a duplicate inside ONE root (later module wins)', async () => {
    await write('one/a_step.ts', stepModule('dup', 'a'));
    await write('one/b_step.ts', stepModule('dup', 'b'));
    const server = new FakeStepServer();
    await registerStepsFromDir(server, dir('one'));
    expect(await server.handlers.get('dup')?.('1', noopLog)).toBe('b:1');
  });
});

describe('generated barrels', () => {
  class Nested {
    static workflow = { name: 'nested' };
    async run() {
      return 'nested';
    }
  }

  it('a single-root barrel with a sub-directory level registers the nested module', async () => {
    // The IndexGenerator nests `app/workflows/billing/refund_workflow.ts` as `{ billing: { Refund } }`;
    // the old loader called `load()` on the inner object and crashed at boot.
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const meta = await registerWorkflowsFromBarrel(engine, {
      billing: { Nested: async () => ({ default: Nested }) },
    });
    expect(meta).toEqual([{ name: 'nested', version: '1' }]);
  });

  it('a multi-root barrel registers every root and rejects a cross-root clash with both keys', async () => {
    class A {
      static workflow = { name: 'charge' };
      async run() {
        return 'a';
      }
    }
    class B {
      static workflow = { name: 'charge' };
      async run() {
        return 'b';
      }
    }
    const ok = new WorkflowEngine({ store: new InMemoryStateStore() });
    const meta = await registerWorkflowsFromBarrel(ok, [
      { root: 'app/a', modules: { 'app/a/charge_workflow.ts': async () => ({ default: A }) } },
      { root: 'app/b', modules: { 'app/b/nested_workflow.ts': async () => ({ default: Nested }) } },
    ]);
    expect(meta.map((m) => m.name)).toEqual(['charge', 'nested']);

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    await expect(
      registerWorkflowsFromBarrel(engine, [
        { root: 'app/a', modules: { 'app/a/charge_workflow.ts': async () => ({ default: A }) } },
        { root: 'app/b', modules: { 'app/b/charge_workflow.ts': async () => ({ default: B }) } },
      ]),
    ).rejects.toThrow(/app\/a\/charge_workflow\.ts and app\/b\/charge_workflow\.ts/);
  });

  it('a multi-root steps barrel serves every root and rejects a cross-root clash', async () => {
    const { defineStep } = await import('../src/step-ref.js');
    const a = defineStep('charge', async () => 'a');
    const b = defineStep('charge', async () => 'b');
    const refund = defineStep('refund', async () => 'r');

    const server = new FakeStepServer();
    await registerStepsFromBarrel(server, [
      { root: 'app/a', modules: { 'app/a/charge_step.ts': async () => ({ a }) } },
      { root: 'app/b', modules: { 'app/b/refund_step.ts': async () => ({ refund }) } },
    ]);
    expect([...server.handlers.keys()]).toEqual(['charge', 'refund']);

    await expect(
      registerStepsFromBarrel(new FakeStepServer(), [
        { root: 'app/a', modules: { 'app/a/charge_step.ts': async () => ({ a }) } },
        { root: 'app/b', modules: { 'app/b/charge_step.ts': async () => ({ b }) } },
      ]),
    ).rejects.toThrow(DuplicateDiscoveryError);
  });
});

describe('escape hatch: the engine serves steps (registerStepsFromDir(engine, dir))', () => {
  it('registers a directory of steps on the engine transport, reachable from a workflow', async () => {
    await write('extra/charge_step.ts', stepModule('charge', 'extra'));
    const engine = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    engine.register('pay', '1', (ctx, input) => ctx.step('charge', input));

    const meta = await registerStepsFromDir(engine, dir('extra'));
    expect(meta).toEqual([{ name: 'charge' }]);
    await engine.start('pay', '7', 'p1');
    const run = await engine.waitForRun('p1', { terminal: true, timeoutMs: 5000 });
    expect(run.status).toBe('completed');
    expect(run.output).toBe('extra:7');
  });

  it('throws a clear error when the engine has no transport that serves handlers', () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    expect(() => engine.handle('x', () => 1)).toThrow(/no transport that serves step handlers/);
  });
});

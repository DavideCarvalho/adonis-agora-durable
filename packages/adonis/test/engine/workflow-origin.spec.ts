import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { originOfFile } from '../../src/origin.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import {
  discoverWorkflows,
  registerWorkflowClass,
  registerWorkflowsFromBarrel,
  registerWorkflowsFromDir,
} from '../../src/workflow-discovery.js';
import { workflowAnnouncement } from '../../src/workflow-ref.js';
import {
  ExplicitLibWorkflow,
  LibWorkflow,
  registerFakeLib,
  ScheduledLibWorkflow,
} from '../fixtures/origin/fake-lib/index.js';

/** This spec lives in `packages/adonis/test`, so code calling from here is owned by this package. */
const THIS_PACKAGE = '@adonis-agora/durable';
const FIXTURES = fileURLToPath(new URL('../fixtures/origin', import.meta.url));

function makeEngine() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  return { engine, store };
}

async function originOfStartedRun(
  engine: WorkflowEngine,
  store: InMemoryStateStore,
  workflow: string,
): Promise<string | undefined> {
  const runId = `r-${workflow}`;
  await engine.start(workflow, {}, runId);
  return (await store.getRun(runId))?.origin;
}

/** Run `fn` on a "runtime" that hands back no usable stack frame (the shape of a non-V8 runtime). */
function withoutStacks<T>(fn: () => T): T {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    return fn();
  } finally {
    Error.stackTraceLimit = limit;
  }
}

describe('workflow origin derivation', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'origin-derive-scratch-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('derives the app name for a workflow discovered under the app (scan path)', async () => {
    const appWorkflows = join(FIXTURES, 'fake-app/app/workflows');
    const [found] = await discoverWorkflows(appWorkflows);
    expect(found?.origin).toBe('fixture-app');

    const { engine, store } = makeEngine();
    const metas = await registerWorkflowsFromDir(engine, appWorkflows);
    expect(metas).toEqual([
      expect.objectContaining({ name: 'fixture-app-greet', origin: 'fixture-app' }),
    ]);
    expect(await originOfStartedRun(engine, store, 'fixture-app-greet')).toBe('fixture-app');
  });

  it('attributes a lib registering its own workflows to the lib (registerWorkflowClass + engine.register)', async () => {
    const { engine, store } = makeEngine();
    await registerFakeLib(engine);
    expect(await originOfStartedRun(engine, store, 'fake-lib-job')).toBe('@fixture/fake-lib');
    expect(await originOfStartedRun(engine, store, 'fake-lib-fn')).toBe('@fixture/fake-lib');
  });

  it('attributes a direct registerWorkflowClass call to the calling package', async () => {
    const { engine, store } = makeEngine();
    await registerWorkflowClass(engine, LibWorkflow);
    // Called from this spec: the caller is `@adonis-agora/durable`'s test tree, not the fixture lib.
    expect(await originOfStartedRun(engine, store, 'fake-lib-job')).toBe(THIS_PACKAGE);
  });

  it('keeps a decorated class on its declaring package, whoever registers it', async () => {
    const { engine, store } = makeEngine();
    await registerWorkflowClass(engine, ScheduledLibWorkflow);
    expect(await originOfStartedRun(engine, store, 'fake-lib-scheduled')).toBe('@fixture/fake-lib');
    // Its colocated schedule fires runs of that same registration, so they carry the same origin.
    expect(engine.discoveredSchedules.map((s) => s.workflow)).toContain('fake-lib-scheduled');
    expect(workflowAnnouncement(ScheduledLibWorkflow)?.origin).toBe('@fixture/fake-lib');
  });

  it('lets an explicit origin win over every derived signal', async () => {
    const { engine, store } = makeEngine();
    await registerFakeLib(engine);
    expect(await originOfStartedRun(engine, store, 'fake-lib-explicit')).toBe('@acme/explicit');

    engine.register('explicit-fn', '1', async () => 'ok', { origin: '@acme/fn' });
    expect(await originOfStartedRun(engine, store, 'explicit-fn')).toBe('@acme/fn');
    expect(workflowAnnouncement(ExplicitLibWorkflow)?.origin).toBe('@acme/explicit');
  });

  it('leaves an unresolvable workflow with no origin instead of guessing', async () => {
    const { engine, store } = makeEngine();
    withoutStacks(() => engine.register('no-stack-fn', '1', async () => 'ok'));
    await withoutStacks(() => registerWorkflowClass(engine, LibWorkflow));
    expect(await originOfStartedRun(engine, store, 'no-stack-fn')).toBeUndefined();
    expect(await originOfStartedRun(engine, store, 'fake-lib-job')).toBeUndefined();

    // A module with no named package.json anywhere above it (a bare temp dir).
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(
      join(tmp, 'orphan_workflow.ts'),
      "export default class Orphan { static workflow = { name: 'orphan' }; async run() { return 'ok' } }\n",
    );
    const metas = await registerWorkflowsFromDir(engine, tmp);
    expect(metas).toEqual([{ name: 'orphan', version: '1' }]);
    expect(await originOfStartedRun(engine, store, 'orphan')).toBeUndefined();
  });

  it("resolves a built app's build/ output to the app's name", async () => {
    // `node ace build` copies the app's package.json into build/, next to the compiled .js.
    const workflows = join(tmp, 'app/build/app/workflows');
    await mkdir(workflows, { recursive: true });
    await writeFile(join(tmp, 'app/package.json'), JSON.stringify({ name: 'my-app' }));
    await writeFile(join(tmp, 'app/build/package.json'), JSON.stringify({ name: 'my-app' }));
    await writeFile(
      join(workflows, 'built_workflow.js'),
      "export default class Built { static workflow = { name: 'built' }; async run() { return 'ok' } }\n",
    );
    const { engine, store } = makeEngine();
    await registerWorkflowsFromDir(engine, workflows);
    expect(await originOfStartedRun(engine, store, 'built')).toBe('my-app');
  });

  it('resolves a pnpm-installed file to the lib, past a nameless dist/package.json', async () => {
    const pkg = join(tmp, 'node_modules/.pnpm/@scope+lib@1.2.3/node_modules/@scope/lib');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'host-app' }));
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@scope/lib' }));
    await writeFile(join(pkg, 'dist/package.json'), JSON.stringify({ type: 'module' }));
    expect(originOfFile(join(pkg, 'dist/index.js'))).toBe('@scope/lib');
  });

  it('derives barrel modules from the app root the provider passes', async () => {
    await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'barrel-app' }));
    const mod = {
      default: class {
        static workflow = { name: 'barrel-single' };
        async run() {
          return 1;
        }
      },
    };
    const rooted = {
      default: class {
        static workflow = { name: 'barrel-rooted' };
        async run() {
          return 2;
        }
      },
    };
    const { engine, store } = makeEngine();

    await registerWorkflowsFromBarrel(engine, { Single: async () => mod }, undefined, {
      appRoot: pathToFileURL(`${tmp}/`),
    });
    await registerWorkflowsFromBarrel(
      engine,
      [{ root: 'app/flows', modules: { 'app/flows/rooted_workflow.ts': async () => rooted } }],
      undefined,
      { appRoot: tmp },
    );
    expect(await originOfStartedRun(engine, store, 'barrel-single')).toBe('barrel-app');
    expect(await originOfStartedRun(engine, store, 'barrel-rooted')).toBe('barrel-app');
  });

  it('attributes a barrel registered without an app root to its caller', async () => {
    const mod = {
      default: class {
        static workflow = { name: 'barrel-caller' };
        async run() {
          return 1;
        }
      },
    };
    const { engine, store } = makeEngine();
    await registerWorkflowsFromBarrel(engine, { M: async () => mod });
    expect(await originOfStartedRun(engine, store, 'barrel-caller')).toBe(THIS_PACKAGE);
  });
});

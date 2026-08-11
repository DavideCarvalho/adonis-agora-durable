import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { startRun } from '../../src/test-helpers.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import {
  discoverWorkflows,
  registerWorkflowClass,
  registerWorkflowsFromDir,
} from '../../src/workflow-discovery.js';
import { workflowMeta, workflowName } from '../../src/workflow-ref.js';

// Absolute path to the package src so a temp workflow module can import BaseWorkflow without the alias.
const SRC = fileURLToPath(new URL('../../src', import.meta.url));

describe('static workflow config', () => {
  it('exposes the registered name and full metadata (default version 1)', () => {
    class Greet {
      static workflow = { name: 'greet' };
      async run(_ctx: unknown, input: { name: string }) {
        return `hi ${input.name}`;
      }
    }
    expect(workflowName(Greet as never)).toBe('greet');
    expect(workflowMeta(Greet)).toEqual({ name: 'greet', version: '1' });
  });

  it('carries version/tags/onEvent through the metadata', () => {
    class Order {
      static workflow = {
        name: 'order',
        version: '2',
        tags: ['billing'],
        onEvent: ['order.placed'],
      };
      async run() {
        return 'done';
      }
    }
    expect(workflowMeta(Order)).toMatchObject({
      name: 'order',
      version: '2',
      tags: ['billing'],
      onEvent: ['order.placed'],
    });
  });
});

describe('app/workflows auto-discovery', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'durable-wf-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('discovers + registers an exported `static workflow` class so it is runnable', async () => {
    await writeFile(
      join(dir, 'greet_workflow.ts'),
      `export default class GreetWorkflow {
         static workflow = { name: 'greet', version: '1' }
         async run(_ctx, input) { return 'hi ' + input.name }
       }`,
    );

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const registered = await registerWorkflowsFromDir(engine, dir);
    expect(registered).toEqual([{ name: 'greet', version: '1' }]);

    const res = await startRun(engine, 'greet', { name: 'davi' }, 'g1');
    expect(res.output).toBe('hi davi');
  });

  it('discovers + registers a BaseWorkflow `static workflow` class (no decorator), runnable', async () => {
    await writeFile(
      join(dir, 'checkout_workflow.ts'),
      `import { BaseWorkflow } from '${SRC}/base-workflow.js'
       export default class CheckoutWorkflow extends BaseWorkflow {
         static workflow = { name: 'checkout', version: '1' }
         async run(_ctx, input) { return 'checkout:' + input.id }
       }`,
    );

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const registered = await registerWorkflowsFromDir(engine, dir);
    expect(registered).toEqual([{ name: 'checkout', version: '1' }]);

    const res = await startRun(engine, 'checkout', { id: 'x' }, 'co1');
    expect(res.output).toBe('checkout:x');
  });

  it('discovers workflow classes in NESTED directories (matches make:workflow nested paths)', async () => {
    await mkdir(join(dir, 'billing'), { recursive: true });
    await writeFile(
      join(dir, 'billing', 'charge_workflow.ts'),
      `import { BaseWorkflow } from '${SRC}/base-workflow.js'
       export default class ChargeWorkflow extends BaseWorkflow {
         static workflow = { name: 'billing.charge', version: '1' }
         async run(_ctx, input) { return 'charged:' + input.id }
       }`,
    );

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const registered = await registerWorkflowsFromDir(engine, dir);
    expect(registered).toEqual([{ name: 'billing.charge', version: '1' }]);

    const res = await startRun(engine, 'billing.charge', { id: 'x' }, 'c1');
    expect(res.output).toBe('charged:x');
  });

  it('returns an empty list for a missing directory (convention is opt-in)', async () => {
    expect(await discoverWorkflows(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('ignores non-workflow modules', async () => {
    await writeFile(join(dir, 'helpers.ts'), 'export const x = 1');
    expect(await discoverWorkflows(dir)).toEqual([]);
  });
});

describe('registerWorkflowClass colocated schedules', () => {
  it('registers a class`s `static schedule` on the engine (derived key = workflow name)', async () => {
    class ReportWorkflow {
      static workflow = { name: 'report' };
      static schedule = { cron: '0 4 * * *', timezone: 'America/Sao_Paulo' };
      async run() {
        return 'ok';
      }
    }
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    expect(await registerWorkflowClass(engine, ReportWorkflow)).toBe(true);
    expect(engine.discoveredSchedules).toEqual([
      { workflow: 'report', key: 'report', cron: '0 4 * * *', timezone: 'America/Sao_Paulo' },
    ]);
  });

  it('registers nothing for a workflow class without `static schedule`', async () => {
    class PlainWorkflow {
      static workflow = { name: 'plain' };
      async run() {}
    }
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    await registerWorkflowClass(engine, PlainWorkflow);
    expect(engine.discoveredSchedules).toEqual([]);
  });

  it('dedupes on key across repeated registration (first wins, idempotent)', async () => {
    class ReportWorkflow {
      static workflow = { name: 'report' };
      static schedule = { everyMs: 60_000 };
      async run() {}
    }
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    await registerWorkflowClass(engine, ReportWorkflow);
    // Re-scan of the same class (both discovery paths funnel through here) must not double-register.
    await registerWorkflowClass(engine, ReportWorkflow);
    expect(engine.discoveredSchedules).toEqual([
      { workflow: 'report', key: 'report', everyMs: 60_000 },
    ]);
  });
});

describe('registerWorkflowClass colocated singleton', () => {
  it('carries `static workflow.singleton` through to the engine: same-key runs serialize', async () => {
    // The functional proof, not a metadata echo: before the passthrough existed, this class
    // registered fine but BOTH runs below would execute concurrently — `SingletonConfig` was
    // reachable only via a manual `engine.register(..., { singleton })`, never via discovery.
    const ran: string[] = [];
    class MutexedWorkflow {
      static workflow = {
        name: 'mutexed',
        singleton: { key: () => 'the-one' },
      };
      async run(
        ctx: {
          localStep: (n: string, f: () => Promise<void>) => Promise<void>;
          waitForSignal: (s: string) => Promise<unknown>;
        },
        input: unknown,
      ) {
        const { id } = input as { id: string };
        await ctx.localStep('enter', async () => void ran.push(id));
        await ctx.waitForSignal(`go:${id}`); // hold the slot until signalled
        return 'done';
      }
    }
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    expect(await registerWorkflowClass(engine, MutexedWorkflow)).toBe(true);

    // A takes the slot and holds it on its signal wait; B shares the key so it must gate.
    await startRun(engine, 'mutexed', { id: 'A' }, 'a');
    await startRun(engine, 'mutexed', { id: 'B' }, 'b');
    expect(ran).toEqual(['A']);

    // Releasing A admits B via notify-on-release (no timer tick needed) — the gate is the
    // engine's own singleton admission, fed by discovery. The wake is dispatched
    // asynchronously, so poll for B's `enter` like the engine's own singleton spec does.
    await engine.signal('go:A', undefined);
    await engine.waitForRun('a', { terminal: true });
    for (let i = 0; i < 100 && !ran.includes('B'); i++) await new Promise((r) => setTimeout(r, 2));
    expect(ran).toEqual(['A', 'B']);
    await engine.signal('go:B', undefined);
    await engine.waitForRun('b', { terminal: true });
  });

  it('workflowMeta echoes the singleton config verbatim', () => {
    const singleton = { key: () => 'k', limit: 2 };
    class Limited {
      static workflow = { name: 'limited', singleton };
      async run() {}
    }
    expect(workflowMeta(Limited)?.singleton).toBe(singleton);
  });
});

describe('workflow class factory (constructor injection)', () => {
  it('uses the provided factory to instantiate the workflow (default is new Ctor())', async () => {
    const service = { label: 'injected' };
    const make = vi.fn();
    class InjectWorkflow {
      static workflow = { name: 'inject' };
      constructor(public injected: { label: string }) {
        // O container resolveria; aqui simulamos `app.container.make(Ctor)`.
        make(this.constructor);
      }
      async run(_ctx: unknown) {
        return this.injected.label;
      }
    }

    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const ok = await registerWorkflowClass(
      engine,
      InjectWorkflow,
      (Ctor) => new (Ctor as new (s: { label: string }) => InjectWorkflow)(service),
    );
    expect(ok).toBe(true);
    expect(make).toHaveBeenCalledWith(InjectWorkflow);

    const res = await startRun(engine, 'inject', undefined, 'inj1');
    expect(res.output).toBe('injected');
  });
});

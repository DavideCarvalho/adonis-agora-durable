import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StepLogger, SubProcessHandle } from '../src/interfaces.js';
import type { StepHandler } from '../src/protocol.js';
import {
  registerStepsFromBarrel,
  registerStepsFromDir,
  type StepServer,
} from '../src/step-discovery.js';
import { Pricing, PricingSteps } from './fixtures/steps-inject/pricing_steps.js';

const noopLog: StepLogger = {
  signal: new AbortController().signal,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  heartbeat: () => {},
  sub: () => {},
  subEvent: () => {},
  subProcess: async (_name, body) => {
    const handle: SubProcessHandle = {
      phase: () => handle,
      skip: () => {},
      fail: () => {},
    };
    return body(handle);
  },
};

/**
 * Regression coverage for the bug where `registerStepsFromDir` derived the extension to import
 * from `import.meta.url` (this library's own compiled file) instead of from the directory being
 * scanned. In a consuming app the library resolves as built `.js` from `node_modules`, while
 * `app/steps` is `.ts` in dev — every entry was silently skipped and nothing registered. Fixed by
 * deriving the extension from the scanned directory's own entries (`pickModuleExt`, shared with
 * `workflow-discovery.ts`).
 *
 * Mutation-proven: temporarily restoring
 * `const MODULE_EXT = extname(import.meta.url || '') === '.ts' ? '.ts' : '.js';`
 * makes the "finds steps in a .js-only directory" case below fail. Under vitest,
 * `step-discovery.ts` runs directly from its `.ts` source (not from a compiled `dist/`), so
 * `import.meta.url` ends in `.ts` and the old expression always resolved to `.ts` in THIS test
 * environment — coincidentally right for the `.ts`-only fixture, but wrong for the `.js`-only one.
 * In a real consuming app the library is resolved as compiled `.js` from `node_modules`, so the old
 * expression would instead always resolve to `.js` there — wrong for a dev app's `.ts` files, which
 * is the actual bug this fix addresses.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

class FakeStepServer implements StepServer {
  readonly handlers = new Map<string, StepHandler>();
  handle(name: string, fn: StepHandler): void {
    this.handlers.set(name, fn);
  }
}

describe('registerStepsFromDir — module extension derived from the scanned directory', () => {
  it('[the regression] finds steps in a .ts-only directory', async () => {
    const server = new FakeStepServer();
    const registered = await registerStepsFromDir(server, fixture('steps-ts'));
    expect(registered).toEqual([{ name: 'charge' }]);
    const handler = server.handlers.get('charge');
    expect(await handler?.({ amount: 5 }, noopLog)).toBe('ts:5');
  });

  it('finds steps in a .js-only directory', async () => {
    const server = new FakeStepServer();
    const registered = await registerStepsFromDir(server, fixture('steps-js'));
    expect(registered).toEqual([{ name: 'charge' }]);
    const handler = server.handlers.get('charge');
    expect(await handler?.({ amount: 5 }, noopLog)).toBe('js:5');
  });

  it('a mixed .ts/.js directory registers the module once, preferring .ts (the .js twin is never imported)', async () => {
    const server = new FakeStepServer();
    const registered = await registerStepsFromDir(server, fixture('steps-mixed'));
    expect(registered).toEqual([{ name: 'charge' }]);
    const handler = server.handlers.get('charge');
    // If the .js twin had also been imported, this would be 'js:5' (last write wins).
    expect(await handler?.({ amount: 5 }, noopLog)).toBe('ts:5');
  });

  it('ignores a .d.ts file alongside a real module', async () => {
    const server = new FakeStepServer();
    const registered = await registerStepsFromDir(server, fixture('steps-with-dts'));
    expect(registered).toEqual([{ name: 'charge' }]);
  });

  it('returns an empty result for a missing directory without throwing', async () => {
    const server = new FakeStepServer();
    await expect(registerStepsFromDir(server, fixture('does-not-exist'))).resolves.toEqual([]);
  });
});

/**
 * Step classes are built by the factory `registerStepsFromDir` / `registerStepsFromBarrel` receive —
 * the provider passes `(Ctor) => app.container.make(Ctor)`, like `app/workflows` — ON EVERY HANDLER
 * CALL, like an `@adonisjs/queue` job. So a `@Step` body that uses a constructor-injected service has
 * it, and a `container.swap(...)` made after registration is seen by the next execution. Before,
 * discovery always ran `new Ctor()` once, and `this.pricing` was `undefined` when the handler ran.
 */

/** Plays `app.container.make(Ctor)` + `container.swap(Pricing, ...)`: resolves the constructor
 *  dependency `@inject()` would declare, from whatever is currently bound for `Pricing`. */
function fakeContainer() {
  let pricing: () => Pricing = () => new Pricing();
  return {
    swap(factory: () => Pricing) {
      pricing = factory;
    },
    make: async (Ctor: new () => object): Promise<object> =>
      (Ctor as unknown) === PricingSteps ? new PricingSteps(pricing()) : new Ctor(),
  };
}

describe('registerStepsFromDir — step class factory (constructor injection)', () => {
  it('builds a step class through the container, so its injected dependency is there when the handler runs', async () => {
    const container = fakeContainer();
    const server = new FakeStepServer();
    const registered = await registerStepsFromDir(server, fixture('steps-inject'), (Ctor) =>
      container.make(Ctor),
    );
    expect(registered.map((m) => m.name).sort()).toEqual([
      'plain:add',
      'plain:ping',
      'pricing:quote',
    ]);
    expect(await server.handlers.get('pricing:quote')?.({ amount: 5 }, noopLog)).toBe('BRL 5');
    expect(await server.handlers.get('plain:add')?.({ n: 1 }, noopLog)).toBe(11);
    expect(await server.handlers.get('plain:ping')?.(undefined, noopLog)).toBe('pong');
  });

  it('resolves the instance on every call, so a swap made after registration reaches the next execution', async () => {
    const container = fakeContainer();
    const server = new FakeStepServer();
    await registerStepsFromDir(server, fixture('steps-inject'), (Ctor) => container.make(Ctor));
    const quote = server.handlers.get('pricing:quote');
    expect(await quote?.({ amount: 1 }, noopLog)).toBe('BRL 1');

    container.swap(
      () => ({ currency: 'FAKE', quote: (n: number) => `fake ${n}` }) as unknown as Pricing,
    );
    expect(await quote?.({ amount: 2 }, noopLog)).toBe('fake 2');
  });

  it('calls the factory per handler call, never at registration and never for a defineStep function', async () => {
    const built: string[] = [];
    const server = new FakeStepServer();
    await registerStepsFromDir(server, fixture('steps-inject'), async (Ctor) => {
      built.push(Ctor.name);
      return new (Ctor as unknown as new (p: Pricing) => object)(new Pricing());
    });
    expect(built).toEqual([]);
    await server.handlers.get('pricing:quote')?.({ amount: 7 }, noopLog);
    await server.handlers.get('pricing:quote')?.({ amount: 8 }, noopLog);
    await server.handlers.get('plain:ping')?.(undefined, noopLog);
    expect(built).toEqual(['PricingSteps', 'PricingSteps']);
  });

  it('applies the factory to a barrel too', async () => {
    const container = fakeContainer();
    const server = new FakeStepServer();
    await registerStepsFromBarrel(
      server,
      { pricing: () => import('./fixtures/steps-inject/pricing_steps.js') },
      (Ctor) => container.make(Ctor),
    );
    expect(await server.handlers.get('pricing:quote')?.({ amount: 3 }, noopLog)).toBe('BRL 3');
  });

  it('a factory failure surfaces as that step execution failing', async () => {
    const server = new FakeStepServer();
    await registerStepsFromDir(server, fixture('steps-inject'), (Ctor) => {
      if (Ctor.name === 'PricingSteps') throw new Error('cannot resolve Pricing');
      return new Ctor();
    });
    await expect(server.handlers.get('pricing:quote')?.({ amount: 1 }, noopLog)).rejects.toThrow(
      'cannot resolve Pricing',
    );
    expect(await server.handlers.get('plain:add')?.({ n: 1 }, noopLog)).toBe(11);
  });

  it('without a factory each class is built once with new Ctor() at registration, as before', async () => {
    const server = new FakeStepServer();
    const registered = await registerStepsFromDir(server, fixture('steps-inject'));
    expect(registered.map((m) => m.name).sort()).toEqual([
      'plain:add',
      'plain:ping',
      'pricing:quote',
    ]);
    expect(await server.handlers.get('plain:add')?.({ n: 1 }, noopLog)).toBe(11);
    expect(await server.handlers.get('plain:ping')?.(undefined, noopLog)).toBe('pong');
    // The injected class is built bare: its dependency is missing — what the factory exists for.
    await expect(
      Promise.resolve().then(() => server.handlers.get('pricing:quote')?.({ amount: 1 }, noopLog)),
    ).rejects.toThrow(TypeError);
  });
});

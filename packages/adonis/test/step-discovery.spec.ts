import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StepLogger } from '../src/interfaces.js';
import type { StepHandler } from '../src/protocol.js';
import { type StepServer, registerStepsFromDir } from '../src/step-discovery.js';

const noopLog: StepLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  heartbeat: () => {},
  sub: () => {},
  subEvent: () => {},
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

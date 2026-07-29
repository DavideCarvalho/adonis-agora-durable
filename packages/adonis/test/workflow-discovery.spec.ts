import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverWorkflows } from '../src/workflow-discovery.js';

/**
 * Regression coverage for the bug where `discoverWorkflows` derived the extension to import from
 * `import.meta.url` (this library's own compiled file) instead of from the directory being
 * scanned. In a consuming app the library resolves as built `.js` from `node_modules`, while
 * `app/workflows` is `.ts` in dev — every entry was silently skipped and nothing registered, with
 * no error anywhere. Fixed by deriving the extension from the scanned directory's own entries
 * (see `pickModuleExt` in `../src/workflow-discovery.ts`).
 *
 * Mutation-proven: temporarily restoring
 * `const MODULE_EXT = extname(import.meta.url || '') === '.ts' ? '.ts' : '.js';`
 * makes the "finds workflows in a .js-only directory" case below fail. Under vitest,
 * `workflow-discovery.ts` runs directly from its `.ts` source (not from a compiled `dist/`), so
 * `import.meta.url` ends in `.ts` and the old expression always resolved to `.ts` in THIS test
 * environment — coincidentally right for the `.ts`-only fixture, but wrong for the `.js`-only one.
 * In a real consuming app the library is resolved as compiled `.js` from `node_modules`, so the old
 * expression would instead always resolve to `.js` there — wrong for a dev app's `.ts` files, which
 * is the actual bug this fix addresses.
 */
function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

describe('discoverWorkflows — module extension derived from the scanned directory', () => {
  it('[the regression] finds workflows in a .ts-only directory', async () => {
    const found = await discoverWorkflows(fixture('workflows-ts'));
    expect(found).toHaveLength(1);
    expect(found[0]?.meta).toEqual({ name: 'greet', version: '1' });
    const instance = new found[0]!.cls();
    expect(await instance.run(undefined, { name: 'davi' })).toBe('ts:davi');
  });

  it('finds workflows in a .js-only directory', async () => {
    const found = await discoverWorkflows(fixture('workflows-js'));
    expect(found).toHaveLength(1);
    expect(found[0]?.meta).toEqual({ name: 'greet', version: '1' });
    const instance = new found[0]!.cls();
    expect(await instance.run(undefined, { name: 'davi' })).toBe('js:davi');
  });

  it('a mixed .ts/.js directory registers the module once, preferring .ts (the .js twin is never imported)', async () => {
    const found = await discoverWorkflows(fixture('workflows-mixed'));
    expect(found).toHaveLength(1);
    const instance = new found[0]!.cls();
    // If the .js twin had also been imported, this would be 'js:davi' (last write wins) or the
    // directory would report two entries — either way this assertion would catch it.
    expect(await instance.run(undefined, { name: 'davi' })).toBe('ts:davi');
  });

  it('ignores a .d.ts file alongside a real module', async () => {
    const found = await discoverWorkflows(fixture('workflows-with-dts'));
    expect(found).toHaveLength(1);
    expect(found[0]?.meta).toEqual({ name: 'greet', version: '1' });
  });

  it('returns an empty result for a missing directory without throwing', async () => {
    await expect(discoverWorkflows(fixture('does-not-exist'))).resolves.toEqual([]);
  });
});

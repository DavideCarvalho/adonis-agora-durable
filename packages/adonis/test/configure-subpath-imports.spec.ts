import { describe, expect, it } from 'vitest';
import { DURABLE_SUBPATH_IMPORTS, mergeSubpathImports } from '../src/configure-imports.js';
import stepsHook from '../src/hooks/steps.js';
import workflowsHook from '../src/hooks/workflows.js';

/** Records the `add(name, config)` calls an assembler init hook makes. */
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

describe('configure — package.json subpath imports', () => {
  it('adds both entries to an app that has neither', () => {
    const { imports, added } = mergeSubpathImports({ '#controllers/*': './app/controllers/*.js' });

    expect(added).toEqual(['#workflows/*', '#steps/*']);
    expect(imports).toMatchObject({
      '#controllers/*': './app/controllers/*.js',
      '#workflows/*': './app/workflows/*.js',
      '#steps/*': './app/steps/*.js',
    });
  });

  it('handles a package.json with no imports map at all', () => {
    const { imports, added } = mergeSubpathImports(undefined);
    expect(added).toHaveLength(2);
    expect(imports['#workflows/*']).toBe('./app/workflows/*.js');
  });

  it('never overwrites an alias the app already points elsewhere', () => {
    const { imports, added } = mergeSubpathImports({ '#workflows/*': './src/flows/*.js' });

    // An app that redirected the alias meant it; configure is not the place to overrule that.
    expect(imports['#workflows/*']).toBe('./src/flows/*.js');
    expect(added).toEqual(['#steps/*']);
  });

  it('reports nothing added when both already exist, so a re-run is a no-op', () => {
    const { added } = mergeSubpathImports({ ...DURABLE_SUBPATH_IMPORTS });
    expect(added).toEqual([]);
  });
});

describe('the written aliases match what the generated barrels actually import', () => {
  // The failure this guards is silent and remote: change a hook default here, and a CONSUMER's
  // app boots into ERR_PACKAGE_IMPORT_NOT_DEFINED after a build that reported success. Tying the
  // two together makes that a red test in this repo instead.
  it.each([
    ['workflows', workflowsHook, './app/workflows/*.js'],
    ['steps', stepsHook, './app/steps/*.js'],
  ])('%s', (_label, hook, expectedTarget) => {
    const fake = fakeIndexGenerator();
    (hook as (a: unknown, b: unknown, c: unknown) => void)(undefined, undefined, fake.generator);

    const config = fake.calls[0]?.config as { importAlias: string; source: string };
    const key = `${config.importAlias}/*`;

    expect(DURABLE_SUBPATH_IMPORTS[key]).toBe(expectedTarget);
    expect(DURABLE_SUBPATH_IMPORTS[key]).toBe(`./${config.source}/*.js`);
  });
});

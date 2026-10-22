import { dirname, join, relative } from 'node:path/posix';
import type { IndexGenerator } from '@adonisjs/assembler/index_generator';

/** What the workflows/steps hooks share: the knobs that differ between the two barrels. */
export interface BarrelSourcesSpec {
  /** The `IndexGenerator` source name and the barrel's export name (`workflows` / `steps`). */
  name: 'workflows' | 'steps';
  /** One directory, or several, relative to the app root. */
  source: string | readonly string[];
  /** Alias for the single-directory barrel. `undefined` means "the hook default". */
  importAlias: string | undefined;
  defaultImportAlias: string;
  output: string;
  removeSuffix: string;
}

type CustomGenerator = Extract<Parameters<IndexGenerator['add']>[1], { as: unknown }>['as'];
type Vfs = Parameters<Exclude<CustomGenerator, string>>[0];
type Buffer = Parameters<Exclude<CustomGenerator, string>>[1];

const toUnix = (path: string) => path.replace(/\\/g, '/');
const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Register the barrel source(s) for one hook on the assembler's `IndexGenerator`.
 *
 * - **One directory** (a string, or a one-element array): exactly the historical single source — a
 *   stock `barrelFile` through `importAlias`, so its output is unchanged byte for byte.
 * - **Several directories**: one generator source PER ROOT, all writing the same `output`. Each
 *   source owns its root's file list (the watcher's `addFile`/`removeFile` reach every source, so a
 *   change in any root regenerates), and every source renders the whole barrel from the shared,
 *   per-root state. The result is a single array export — `[{ root, modules: { file: () => import() } }]`
 *   — that the provider's barrel loader registers root by root. Entries import through paths
 *   relative to the barrel (`../../app/orders/flows/charge_workflow.js`), so no per-root
 *   `package.json` alias is needed.
 */
export function addBarrelSources(indexGenerator: IndexGenerator, spec: BarrelSourcesSpec): void {
  const roots = [...new Set(typeof spec.source === 'string' ? [spec.source] : spec.source)];
  if (roots.length === 0) {
    throw new Error(
      `@agora/durable: the ${spec.name} hook needs at least one \`source\` directory; to turn the barrel off, remove the hook from adonisrc.ts.`,
    );
  }

  if (roots.length === 1) {
    indexGenerator.add(spec.name, {
      source: roots[0] as string,
      as: 'barrelFile',
      exportName: spec.name,
      importAlias: spec.importAlias ?? spec.defaultImportAlias,
      // `app/workflows/billing/charge_workflow.ts` → key `Billing/Charge`; the suffix is dropped so a
      // barrel key reads as the class, mirroring controllers' `removeSuffix: 'controller'`.
      removeSuffix: spec.removeSuffix,
      skipSegments: [spec.name],
      output: spec.output,
      comment: true,
    });
    return;
  }

  if (spec.importAlias !== undefined) {
    throw new Error(
      `@agora/durable: the ${spec.name} hook's \`importAlias\` applies to a single \`source\`; with several directories the barrel imports each module through a relative path, so drop \`importAlias\`.`,
    );
  }

  const appRoot = toUnix(indexGenerator.appRoot);
  const outputDir = dirname(join(appRoot, toUnix(spec.output)));
  // root → that root's modules as [app-relative file, import specifier], refreshed by its own source.
  const state = new Map<string, Array<[string, string]>>(roots.map((root) => [root, []]));

  const render = (buffer: Buffer) => {
    buffer.write(`export const ${spec.name} = [`).indent();
    for (const root of roots) {
      buffer.write('{').indent();
      buffer.write(`root: ${quote(root)},`);
      const modules = state.get(root) ?? [];
      if (modules.length === 0) {
        buffer.write('modules: {},');
      } else {
        buffer.write('modules: {').indent();
        for (const [file, specifier] of modules) {
          buffer.write(`${quote(file)}: () => import(${quote(specifier)}),`);
        }
        buffer.dedent().write('},');
      }
      buffer.dedent().write('},');
    }
    buffer.dedent().write(']');
  };

  for (const root of roots) {
    indexGenerator.add(`${spec.name}:${root}`, {
      source: root,
      output: spec.output,
      comment: true,
      as: (vfs: Vfs, buffer: Buffer) => {
        const files = Object.values(vfs.asList()).map((file) => toUnix(file));
        files.sort();
        // A built `foo.js` next to its `foo.ts` source is ONE module: keep a single entry per
        // specifier, keyed by the `.ts` file when both are present.
        const bySpecifier = new Map<string, string>();
        for (const file of files) {
          let specifier = relative(outputDir, file).replace(/\.tsx?$/, '.js');
          if (!specifier.startsWith('.')) specifier = `./${specifier}`;
          const known = bySpecifier.get(specifier);
          if (known === undefined || !/\.tsx?$/.test(known)) bySpecifier.set(specifier, file);
        }
        state.set(
          root,
          [...bySpecifier].map(([specifier, file]): [string, string] => [
            relative(appRoot, file),
            specifier,
          ]),
        );
        render(buffer);
      },
    });
  }
}

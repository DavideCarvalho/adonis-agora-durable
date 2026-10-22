import type { IndexGenerator } from '@adonisjs/assembler/index_generator';
import { addBarrelSources } from './barrel-sources.js';

/**
 * Where the generated workflows barrel is written, relative to the app root. The durable provider
 * imports THIS path at boot (build-time codegen) instead of scanning `app/workflows` with `readdir`
 * at runtime. Kept in sync with {@link GENERATED_WORKFLOWS_MODULE} the provider imports.
 */
export const GENERATED_WORKFLOWS_OUTPUT = '.adonisjs/durable/workflows.ts';

/**
 * Options for {@link workflowsHook} — mirror the relevant `IndexGenerator.add` knobs so an app can
 * point the generator at a non-default workflows directory or import alias.
 */
export interface WorkflowsHookOptions {
  /**
   * Directory the generator scans for workflow modules, relative to the app root. Default `app/workflows`.
   * Pass several directories (a modular app: one per bounded context) to get ONE barrel covering
   * all of them; list the same directories in `config/durable.ts` (`workflowsPath`) so the
   * runtime-scan fallback agrees with the barrel.
   */
  source?: string | readonly string[];
  /**
   * Import alias the generated barrel uses for each workflow module. Default `#workflows`. Single
   * `source` only: a multi-directory barrel imports through relative paths, and passing an alias
   * with several directories throws.
   */
  importAlias?: string;
  /** Output path for the generated barrel, relative to the app root. Default `.adonisjs/durable/workflows.ts`. */
  output?: string;
}

/**
 * An AdonisJS **Assembler `init` hook** that generates a typed barrel of the app's `app/workflows/`
 * directory at build/dev time — exactly how `@adonisjs/core` generates the controllers/events/listeners
 * barrels (`indexEntities`). The build-time barrel replaces the provider's runtime `readdir` scan: the
 * dev server / test runner / bundler runs this `init` hook once, and the file watcher re-runs the
 * `IndexGenerator` (via its tracked `addFile`/`removeFile`) whenever a workflow file changes, so the
 * generated `.adonisjs/durable/workflows.ts` always reflects `app/workflows`.
 *
 * The generated file is a lazy barrel — `export const workflows = { Name: () => import('#workflows/…') }`
 * — which the durable provider imports at boot, awaiting each thunk and registering every workflow
 * export it finds (`BaseWorkflow` subclass; falling back to the runtime scan when the barrel is
 * absent).
 *
 * Register it in `adonisrc.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   hooks: {
 *     init: [() => import('@adonis-agora/durable/hooks/workflows')],
 *   },
 * })
 * ```
 *
 * The default export is the hook object the assembler expects (`{ run(parent, hooks, indexGenerator) }`).
 */
export function workflowsHook(options: WorkflowsHookOptions = {}) {
  // A FUNCTION, not an object with a `run` method. `@poppinss/hooks` — the runner the
  // assembler drives its `init` hooks with — invokes a handler as
  //   `typeof handler === 'function' ? handler(...data) : handler.handle(action, ...data)`
  // so a non-function handler must expose `handle`. Exporting `{ run }` made every app that
  // ran `node ace configure` fail its build with `handler.handle is not a function`, and it
  // also mismatched the assembler's own `DefineHook` type, which is a plain function.
  return function generateWorkflowsBarrel(
    _parent: unknown,
    _hooks: unknown,
    indexGenerator: IndexGenerator,
  ): void {
    addBarrelSources(indexGenerator, {
      name: 'workflows',
      source: options.source ?? 'app/workflows',
      importAlias: options.importAlias,
      defaultImportAlias: '#workflows',
      output: options.output ?? GENERATED_WORKFLOWS_OUTPUT,
      removeSuffix: 'workflow',
    });
  };
}

/** The default export is the hook function itself, so `() => import('@adonis-agora/durable/hooks/workflows')`
 *  in `adonisrc.ts` resolves to a handler the assembler can call directly. */
export default workflowsHook();

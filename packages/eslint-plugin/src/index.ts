import type { ESLint, Linter } from 'eslint';
import { noIoInWorkflowBody } from './no-io-in-workflow-body.js';
import { noNondeterminism } from './no-nondeterminism.js';
import { rethrowControlFlowSignals } from './rethrow-control-flow-signals.js';

/** Keep in sync with this package's `version` in package.json (guarded by `test/version.spec.ts`). */
export const VERSION = '1.0.1';

export const rules = {
  'no-nondeterminism': noNondeterminism,
  'rethrow-control-flow-signals': rethrowControlFlowSignals,
  'no-io-in-workflow-body': noIoInWorkflowBody,
};

/** The flat-config presets this plugin ships. */
export interface DurableConfigs {
  /** Registers the plugin under `@adonis-agora/durable` and turns every rule on at `error`. */
  recommended: Linter.Config;
}

const plugin = {
  meta: { name: '@adonis-agora/durable-eslint-plugin', version: VERSION },
  rules,
  // Filled in just below, once `plugin` exists for the preset to reference.
  configs: {} as DurableConfigs,
};

// Flat-config preset: `extends` it (or spread) to turn the rules on. Defined after `plugin` so it can
// reference the plugin object itself (the flat-config way to register a plugin + its rules).
plugin.configs.recommended = {
  // Type-only cast: typescript-eslint's RuleModule and ESLint's RuleDefinition describe the same
  // runtime object with different context types, so the plugin is widened to ESLint's `Plugin`.
  plugins: { '@adonis-agora/durable': plugin as unknown as ESLint.Plugin },
  rules: {
    '@adonis-agora/durable/no-nondeterminism': 'error',
    '@adonis-agora/durable/rethrow-control-flow-signals': 'error',
    '@adonis-agora/durable/no-io-in-workflow-body': 'error',
  },
};

// Typed as ESLint's `Plugin` too (type-only, same object) so `plugins: { '@adonis-agora/durable': plugin }`
// typechecks in a typed flat config.
const typedPlugin = plugin as typeof plugin & ESLint.Plugin;

export const configs = plugin.configs;
export { noIoInWorkflowBody, noNondeterminism, rethrowControlFlowSignals };
export default typedPlugin;

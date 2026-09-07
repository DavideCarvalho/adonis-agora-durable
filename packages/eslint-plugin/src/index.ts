import { noIoInWorkflowBody } from './no-io-in-workflow-body.js';
import { noNondeterminism } from './no-nondeterminism.js';
import { rethrowControlFlowSignals } from './rethrow-control-flow-signals.js';

/** Keep in sync with this package's `version` in package.json (guarded by `test/version.spec.ts`). */
export const VERSION = '0.3.0';

export const rules = {
  'no-nondeterminism': noNondeterminism,
  'rethrow-control-flow-signals': rethrowControlFlowSignals,
  'no-io-in-workflow-body': noIoInWorkflowBody,
};

const plugin = {
  meta: { name: '@adonis-agora/durable-eslint-plugin', version: VERSION },
  rules,
  configs: {} as Record<string, unknown>,
};

// Flat-config preset: `extends` it (or spread) to turn the rules on. Defined after `plugin` so it can
// reference the plugin object itself (the flat-config way to register a plugin + its rules).
plugin.configs.recommended = {
  plugins: { '@adonis-agora/durable': plugin },
  rules: {
    '@adonis-agora/durable/no-nondeterminism': 'error',
    '@adonis-agora/durable/rethrow-control-flow-signals': 'error',
    '@adonis-agora/durable/no-io-in-workflow-body': 'error',
  },
};

export const configs = plugin.configs;
export { noIoInWorkflowBody, noNondeterminism, rethrowControlFlowSignals };
export default plugin;

import { noNondeterminism } from './no-nondeterminism.js';

/** Keep in sync with this package's `version` in package.json (guarded by `test/version.spec.ts`). */
export const VERSION = '0.2.2';

export const rules = {
  'no-nondeterminism': noNondeterminism,
};

const plugin = {
  meta: { name: '@adonis-agora/durable-eslint-plugin', version: VERSION },
  rules,
  configs: {} as Record<string, unknown>,
};

// Flat-config preset: `extends` it (or spread) to turn the rule on. Defined after `plugin` so it can
// reference the plugin object itself (the flat-config way to register a plugin + its rules).
plugin.configs.recommended = {
  plugins: { '@adonis-agora/durable': plugin },
  rules: { '@adonis-agora/durable/no-nondeterminism': 'error' },
};

export const configs = plugin.configs;
export { noNondeterminism };
export default plugin;

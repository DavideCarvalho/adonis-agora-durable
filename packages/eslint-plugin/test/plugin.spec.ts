import type { Linter } from 'eslint';
import { defineConfig } from 'eslint/config';
import { describe, expect, it } from 'vitest';
import plugin, { configs, rules } from '../src/index.js';

describe('plugin', () => {
  it('exposes every rule', () => {
    for (const name of [
      'no-nondeterminism',
      'rethrow-control-flow-signals',
      'no-io-in-workflow-body',
    ] as const) {
      expect(rules[name]).toBeDefined();
      expect(plugin.rules[name]).toBe(rules[name]);
    }
  });

  it('exposes a flat-config recommended preset that turns every rule on', () => {
    const recommended = configs.recommended as {
      plugins: Record<string, unknown>;
      rules: Record<string, string>;
    };
    expect(recommended.plugins['@adonis-agora/durable']).toBe(plugin);
    for (const name of Object.keys(rules)) {
      expect(recommended.rules[`@adonis-agora/durable/${name}`]).toBe('error');
    }
  });

  it('carries plugin meta', () => {
    expect(plugin.meta.name).toBe('@adonis-agora/durable-eslint-plugin');
  });

  it('types the preset and the plugin for a typed flat config', () => {
    // Compile-time checks (run by `typecheck`): spreading the preset, `extends`, and manual
    // registration must all fit ESLint's own config types.
    const spread: Linter.Config[] = [
      plugin.configs.recommended,
      { files: ['app/**/*.ts'], ...configs.recommended },
      { plugins: { '@adonis-agora/durable': plugin } },
    ];
    const extended = defineConfig({ files: ['app/**/*.ts'], extends: [configs.recommended] });
    expect(spread).toHaveLength(3);
    expect(extended.length).toBeGreaterThan(0);
  });
});

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
});

import Hooks from '@poppinss/hooks';
import { describe, expect, it } from 'vitest';
import defaultHook, { GENERATED_STEPS_OUTPUT, stepsHook } from '../../src/hooks/steps.js';

/** A minimal stand-in for the Assembler IndexGenerator: records the `add(name, config)` calls. */
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

describe('steps assembler init hook', () => {
  it('the default export is a FUNCTION, which is what the hook runner calls', () => {
    expect(typeof defaultHook).toBe('function');
    expect(GENERATED_STEPS_OUTPUT).toBe('.adonisjs/durable/steps.ts');
  });

  it('runs through @poppinss/hooks — the runner the assembler actually drives it with', async () => {
    // This hook had no test at all while it shipped broken: @poppinss/hooks calls a non-function
    // handler as `handler.handle(action, ...data)`, so the previous `{ run }` export killed every
    // `node ace build` in an app that ran `node ace configure`.
    const fake = fakeIndexGenerator();
    const hooks = new Hooks();
    hooks.add('init', defaultHook as never);

    await hooks.runner('init').run(undefined, undefined, fake.generator as never);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.name).toBe('steps');
  });

  it('registers a `steps` barrelFile source with the expected defaults', () => {
    const fake = fakeIndexGenerator();
    defaultHook(undefined, undefined, fake.generator as never);

    expect(fake.calls[0]?.config).toMatchObject({
      source: 'app/steps',
      as: 'barrelFile',
      exportName: 'steps',
      importAlias: '#steps',
      removeSuffix: 'step',
      output: '.adonisjs/durable/steps.ts',
    });
  });

  it('honours custom source / importAlias / output options', () => {
    const fake = fakeIndexGenerator();
    stepsHook({
      source: 'app/tasks',
      importAlias: '#tasks',
      output: '.adonisjs/custom/tasks.ts',
    })(undefined, undefined, fake.generator as never);

    expect(fake.calls[0]?.config).toMatchObject({
      source: 'app/tasks',
      importAlias: '#tasks',
      output: '.adonisjs/custom/tasks.ts',
    });
  });
});

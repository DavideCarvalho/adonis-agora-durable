import { defineStep, Step } from '../../../src/step-ref.js';

/** A step class with no constructor dependencies: built the same with or without a factory. */
export class PlainSteps {
  base = 10;

  @Step('plain:add')
  add(input: { n: number }) {
    return this.base + input.n;
  }
}

export const ping = defineStep('plain:ping', async () => 'pong');

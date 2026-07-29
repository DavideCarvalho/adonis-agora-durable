import { defineStep } from '../../../src/step-ref.js';

export const charge = defineStep('charge', async (input) => `js:${input.amount}`);

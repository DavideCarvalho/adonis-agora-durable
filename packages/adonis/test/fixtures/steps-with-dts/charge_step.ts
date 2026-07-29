import { defineStep } from '../../../src/step-ref.js';

export const charge = defineStep('charge', async (input: { amount: number }) => `ts:${input.amount}`);

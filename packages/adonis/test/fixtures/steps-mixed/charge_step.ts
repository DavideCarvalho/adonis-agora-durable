import { defineStep } from '../../../src/step-ref.js';

// Same step name as the sibling .js in this directory, on purpose: proves the `.ts` extension wins
// and the `.js` twin is never imported.
export const charge = defineStep('charge', async (input: { amount: number }) => `ts:${input.amount}`);

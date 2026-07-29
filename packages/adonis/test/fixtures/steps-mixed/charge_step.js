import { defineStep } from '../../../src/step-ref.js';

// Same step name as the sibling .ts in this directory, on purpose: if this file were ever
// imported alongside the .ts, the spec's assertion on the handler's output would catch it.
export const charge = defineStep('charge', async (input) => `js:${input.amount}`);

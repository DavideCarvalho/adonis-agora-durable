// Extensionless specifier — see the comment in `steps-js/charge_step.js` for why: an explicit
// `.js` extension here only resolves to the sibling `src/step-ref.ts` via a Vite fallback gated on
// the IMPORTING file being TS, which this plain `.js` file isn't.
import { defineStep } from '../../../src/step-ref';

// Same step name as the sibling .ts in this directory, on purpose: if this file were ever
// imported alongside the .ts, the spec's assertion on the handler's output would catch it.
export const charge = defineStep('charge', async (input) => `js:${input.amount}`);

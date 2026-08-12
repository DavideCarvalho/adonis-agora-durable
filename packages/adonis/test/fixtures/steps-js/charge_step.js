// Extensionless specifier: `src/step-ref` only exists as `.ts` in this dev/test tree (no build
// step runs here), and this file is itself plain `.js`. Vite's resolver only falls back from an
// explicit `../step-ref.js` to the sibling `.ts` file when the IMPORTING file is itself TS
// (`isFromTsImporter`) — see `steps-ts/charge_step.ts`, which relies on exactly that. A plain `.js`
// importer doesn't get that fallback, so an explicit `.js` extension here fails to resolve once
// `vite`'s resolver is the one running (e.g. once `vite` is present anywhere in the pnpm
// workspace's dependency tree, as it now is via `packages/dashboard`). Dropping the extension goes
// through Vite's ordinary (importer-agnostic) extension-probing instead, which finds `step-ref.ts`
// regardless of this file's own extension — robust regardless of what else is in the workspace.
import { defineStep } from '../../../src/step-ref';

export const charge = defineStep('charge', async (input) => `js:${input.amount}`);

// `node --import ./test/support/register-ts.mjs child.ts` — see ts-hooks.mjs.
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);

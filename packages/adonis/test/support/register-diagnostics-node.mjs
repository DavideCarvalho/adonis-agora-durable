// `node --import ./test/support/register-diagnostics-node.mjs diagnostics-node.ts`: the TypeScript
// hooks (see ts-hooks.mjs) plus the `@adonis-agora/durable/diagnostics` self-resolution.
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
register('./durable-self-hooks.mjs', import.meta.url);

import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { noNondeterminism } from '../src/no-nondeterminism.js';

// Wire the rule-tester's lifecycle hooks to vitest.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

// The class form: a `BaseWorkflow` subclass with a `static workflow` config.
const wfClass = (body: string) => `
  class W extends BaseWorkflow {
    static workflow = { name: 'wf', version: '1' };
    async run(ctx) {
      ${body}
    }
  }
`;

// The function form: engine.register(name, version, fn) — Agora's primary API.
const wfFn = (body: string) => `
  engine.register('wf', '1', async (ctx) => {
    ${body}
  });
`;

ruleTester.run('no-nondeterminism', noNondeterminism, {
  valid: [
    // The ctx escape hatches.
    { code: wfClass('const t = await ctx.now(); const d = new Date(t);') },
    { code: wfFn('const t = await ctx.now();') },
    { code: wfFn('const d = new Date(await ctx.now());') },
    // Banned calls OUTSIDE any workflow body.
    { code: 'function f() { return Date.now(); }' },
    { code: 'const r = Math.random();' },
    // A non-`run` method of a workflow class is not the deterministic body.
    {
      code: `class W extends BaseWorkflow { static workflow = { name: 'wf', version: '1' }; helper() { return Math.random(); } }`,
    },
    // A class method named run on a non-workflow class (no BaseWorkflow / static workflow) is just a method.
    { code: 'class Plain { run() { return Date.now(); } }' },
    // Non-determinism inside a ctx.localStep / ctx.task / ctx.sideEffect callback is checkpointed
    // (run once, then replayed) — replay-safe, so it is NOT flagged.
    {
      code: wfClass(
        "const s = await ctx.localStep('setup', async () => new Date().toISOString());",
      ),
    },
    { code: wfFn("await ctx.localStep('setup', async () => { const r = Math.random(); });") },
    { code: wfFn("await ctx.task('t', async () => Date.now());") },
    { code: wfFn('const id = await ctx.sideEffect(() => globalThis.crypto.randomUUID());') },
    { code: wfFn('const r = await ctx.sideEffect(() => Math.random());') },
    // A plain register call to something else is not a workflow body.
    { code: "registry.register('x', () => Date.now());" },
    // An imported randomUUID called OUTSIDE any workflow body.
    { code: "import { randomUUID } from 'node:crypto'; const id = randomUUID();" },
    // An imported randomUUID inside a checkpointed sideEffect callback is replay-safe.
    {
      code:
        "import { randomUUID } from 'node:crypto';" +
        wfFn('const id = await ctx.sideEffect(() => randomUUID());'),
    },
    // A randomUUID import from some OTHER module is not the crypto one.
    { code: `import { randomUUID } from './my-uuid.js';${wfFn('const id = randomUUID();')}` },
    // `process.env` outside a workflow body, and inside a checkpointed callback, are fine.
    { code: 'const url = process.env.API_URL;' },
    { code: wfFn('const url = await ctx.sideEffect(() => process.env.API_URL);') },
    // `Date()` outside a workflow body.
    { code: 'const s = Date();' },
    // Alias tracking is `const`-from-the-global only: an unrelated const is not an alias.
    { code: wfFn('const d = myClock; d.now();') },
    // A `let` binding may be reassigned — deliberately not tracked (no data-flow analysis).
    { code: `let d = Date;${wfFn('d.now();')}` },
  ],
  invalid: [
    // Class form.
    { code: wfClass('const t = Date.now();'), errors: [{ messageId: 'useNow' }] },
    { code: wfClass('const r = Math.random();'), errors: [{ messageId: 'useRandom' }] },
    { code: wfClass('const d = new Date();'), errors: [{ messageId: 'useNowDate' }] },
    { code: wfClass('const id = crypto.randomUUID();'), errors: [{ messageId: 'useUuid' }] },
    {
      code: wfClass('const id = globalThis.crypto.randomUUID();'),
      errors: [{ messageId: 'useUuid' }],
    },
    { code: wfClass('const t = performance.now();'), errors: [{ messageId: 'useNow' }] },
    // Function form.
    { code: wfFn('const t = Date.now();'), errors: [{ messageId: 'useNow' }] },
    { code: wfFn('const r = Math.random();'), errors: [{ messageId: 'useRandom' }] },
    { code: wfFn('const d = new Date();'), errors: [{ messageId: 'useNowDate' }] },
    { code: wfFn('const id = crypto.randomUUID();'), errors: [{ messageId: 'useUuid' }] },
    // A banned call in the orchestration body, even alongside steps, is still flagged.
    {
      code: wfFn("await ctx.localStep('a', async () => 1); const t = Date.now();"),
      errors: [{ messageId: 'useNow' }],
    },
    // `ctx.step` is now the always-DISPATCHED step (its 2nd arg is data, not a checkpointed body), so
    // it is NOT a boundary — a banned call inside a function reaching it is still flagged.
    {
      code: wfFn("await ctx.step('a', { at: Date.now() });"),
      errors: [{ messageId: 'useNow' }],
    },
    // A bare `randomUUID` import from node:crypto (both module specifiers), incl. the aliased form.
    {
      code: `import { randomUUID } from 'node:crypto';${wfFn('const id = randomUUID();')}`,
      errors: [{ messageId: 'useUuidImport' }],
    },
    {
      code: `import { randomUUID } from 'crypto';${wfFn('const id = randomUUID();')}`,
      errors: [{ messageId: 'useUuidImport' }],
    },
    {
      code: `import { randomUUID as uuid } from 'node:crypto';${wfFn('const id = uuid();')}`,
      errors: [{ messageId: 'useUuidImport' }],
    },
    // A namespace/default crypto import resolves like the `crypto` global.
    {
      code: `import * as c from 'node:crypto';${wfClass('const id = c.randomUUID();')}`,
      errors: [{ messageId: 'useUuid' }],
    },
    // `process.env` reads — bare, and via a property (flagged once, on the `process.env` read).
    { code: wfFn('if (process.env.FEATURE_X) { doIt(); }'), errors: [{ messageId: 'useEnv' }] },
    { code: wfClass('const env = process.env;'), errors: [{ messageId: 'useEnv' }] },
    // `Date()` called as a plain function returns the current-time string.
    { code: wfFn('const s = Date();'), errors: [{ messageId: 'useNowDateCall' }] },
    { code: wfClass('const s = Date();'), errors: [{ messageId: 'useNowDateCall' }] },
    // Aliased receivers, tracked through a same-file `const` from the banned global.
    { code: `const d = Date;${wfFn('const t = d.now();')}`, errors: [{ messageId: 'useNow' }] },
    {
      code: wfFn('const m = Math; const r = m.random();'),
      errors: [{ messageId: 'useRandom' }],
    },
    {
      code: `const c = crypto;${wfClass('const id = c.randomUUID();')}`,
      errors: [{ messageId: 'useUuid' }],
    },
    {
      code: `const d = Date;${wfFn('const at = new d();')}`,
      errors: [{ messageId: 'useNowDate' }],
    },
  ],
});

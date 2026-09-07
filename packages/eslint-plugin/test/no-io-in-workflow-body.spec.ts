import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { noIoInWorkflowBody } from '../src/no-io-in-workflow-body.js';

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

ruleTester.run('no-io-in-workflow-body', noIoInWorkflowBody, {
  valid: [
    // fetch inside a checkpointed callback is recorded once and replayed — the blessed pattern.
    { code: wfFn("const res = await ctx.localStep('get', () => fetch(url));") },
    { code: wfFn("await ctx.task('get', async () => { const r = await fetch(url); });") },
    { code: wfClass("const res = await ctx.sideEffect(() => fetch('https://x.test'));") },
    // fetch OUTSIDE any workflow body.
    { code: 'async function f() { return await fetch(url); }' },
    // Only the GLOBAL fetch is flagged — a receiver means it may be a deterministic wrapper.
    { code: wfFn('const res = await this.fetch(url);') },
    { code: wfFn('const res = await client.fetch(url);') },
    // ctx primitives are the sanctioned way to do work from the orchestration body.
    { code: wfFn("await ctx.step('a', input);") },
    // Raw engine calls outside a workflow body are the normal way to drive the engine — and the
    // enclosing `engine.register(...)` call of every workflow is itself never flagged.
    { code: "await engine.start('wf', '1', input);" },
    // The receiver must be named exactly `engine` — name-based on purpose.
    { code: wfFn('await this.engine.start(input);') },
    { code: wfFn("await engines.get('a').start(input);") },
    // An engine call inside a checkpointed callback is recorded once — replay-safe.
    { code: wfFn("await ctx.localStep('kick', () => engine.start('other', '1', input));") },
  ],
  invalid: [
    // Direct fetch in the orchestration body — both forms, awaited or not.
    { code: wfFn('const res = await fetch(url);'), errors: [{ messageId: 'noFetch' }] },
    { code: wfClass('const res = await fetch(url);'), errors: [{ messageId: 'noFetch' }] },
    { code: wfFn("fetch('https://x.test');"), errors: [{ messageId: 'noFetch' }] },
    // A raw engine call in the orchestration body re-executes on every replay.
    {
      code: wfFn("await engine.start('other', '1', input);"),
      errors: [{ messageId: 'noEngine' }],
    },
    { code: wfClass('await engine.cancel(runId);'), errors: [{ messageId: 'noEngine' }] },
    // `ctx.step` is the always-DISPATCHED step (2nd arg is data, not a callback) — NOT a boundary.
    {
      code: wfFn("await ctx.step('a', { body: await fetch(url) });"),
      errors: [{ messageId: 'noFetch' }],
    },
  ],
});

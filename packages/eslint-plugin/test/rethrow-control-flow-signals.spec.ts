import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import { rethrowControlFlowSignals } from '../src/rethrow-control-flow-signals.js';

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

ruleTester.run('rethrow-control-flow-signals', rethrowControlFlowSignals, {
  valid: [
    // The documented guard pattern, as the first statement.
    {
      code: wfFn(`
        try { await ctx.step('charge', input); }
        catch (e) {
          if (isWorkflowControlFlowSignal(e)) throw e;
          await ctx.step('refund', input);
        }
      `),
    },
    // Guard with a block-bodied consequent, and not necessarily first.
    {
      code: wfClass(`
        try { await ctx.step('charge', input); }
        catch (error) {
          report(error);
          if (isWorkflowControlFlowSignal(error)) { throw error; }
          await this.cleanup();
        }
      `),
    },
    // Guard composed into a larger condition still lets the signal through.
    {
      code: wfFn(`
        try { await ctx.step('charge', input); }
        catch (e) {
          if (isWorkflowControlFlowSignal(e) || e instanceof KnownError) throw e;
        }
      `),
    },
    // An unconditional rethrow of the catch param — signals included.
    {
      code: wfFn(`
        try { await ctx.step('charge', input); }
        catch (e) { log(e); throw e; }
      `),
    },
    // A try over purely synchronous code can never catch a control-flow signal.
    { code: wfFn('try { JSON.parse(raw); } catch (e) { return null; }') },
    { code: wfClass('try { validate(input); } catch { return { ok: false }; }') },
    // An await inside a NESTED function does not make the try itself suspendable.
    { code: wfFn('try { const f = async () => { await g(); }; } catch (e) { log(e); }') },
    // A catch OUTSIDE any workflow body is none of this rule's business.
    { code: 'async function f() { try { await g(); } catch (e) { log(e); } }' },
    // A catch inside a checkpointed callback runs once — no replay, no signal to protect.
    {
      code: wfFn(
        "await ctx.localStep('batch', async () => { try { await h(); } catch (e) { log(e); } });",
      ),
    },
  ],
  invalid: [
    // A swallowing catch in the function form — with the guard suggested as the first statement.
    {
      code: "engine.register('wf', '1', async (ctx) => { try { await ctx.step('a', input); } catch (e) { log(e); } });",
      errors: [
        {
          messageId: 'rethrowSignal',
          suggestions: [
            {
              messageId: 'insertGuard',
              output:
                "engine.register('wf', '1', async (ctx) => { try { await ctx.step('a', input); } catch (e) { if (isWorkflowControlFlowSignal(e)) throw e; log(e); } });",
            },
          ],
        },
      ],
    },
    // Class form.
    {
      code: wfClass("try { await ctx.step('a', input); } catch (e) { return null; }"),
      errors: [
        {
          messageId: 'rethrowSignal',
          suggestions: [
            {
              messageId: 'insertGuard',
              output: wfClass(
                "try { await ctx.step('a', input); } catch (e) { if (isWorkflowControlFlowSignal(e)) throw e; return null; }",
              ),
            },
          ],
        },
      ],
    },
    // A param-less catch can't rethrow at all — reported, but with no suggestion to offer.
    {
      code: wfFn("try { await ctx.sleep('1d'); } catch { log('woke'); }"),
      errors: [{ messageId: 'rethrowSignal', suggestions: [] }],
    },
    // Throwing a DIFFERENT error swallows the signal just the same.
    {
      code: wfFn(
        "try { await ctx.step('a', input); } catch (e) { throw new Error('wrapped: ' + e); }",
      ),
      errors: [
        {
          messageId: 'rethrowSignal',
          suggestions: [
            {
              messageId: 'insertGuard',
              output: wfFn(
                "try { await ctx.step('a', input); } catch (e) { if (isWorkflowControlFlowSignal(e)) throw e; throw new Error('wrapped: ' + e); }",
              ),
            },
          ],
        },
      ],
    },
    // A CONDITIONAL rethrow on something other than the signal predicate is not a guard.
    {
      code: wfFn(
        "try { await ctx.step('a', input); } catch (e) { if (e instanceof HttpError) throw e; }",
      ),
      errors: [
        {
          messageId: 'rethrowSignal',
          suggestions: [
            {
              messageId: 'insertGuard',
              output: wfFn(
                "try { await ctx.step('a', input); } catch (e) { if (isWorkflowControlFlowSignal(e)) throw e; if (e instanceof HttpError) throw e; }",
              ),
            },
          ],
        },
      ],
    },
  ],
});

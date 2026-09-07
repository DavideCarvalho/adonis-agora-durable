import { createRule } from './create-rule.js';
import { isInWorkflowBody } from './workflow-body.js';

type MessageId = 'noFetch' | 'noEngine';

export const noIoInWorkflowBody = createRule<[], MessageId>({
  name: 'no-io-in-workflow-body',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct I/O — global fetch() calls and raw engine.* calls — inside a durable workflow body. The orchestration body re-executes on every replay, so un-checkpointed I/O runs again each time; it must live inside a checkpointed step (ctx.localStep / ctx.task / ctx.sideEffect) so the result is recorded once and replayed.',
    },
    messages: {
      noFetch:
        "Direct `fetch()` inside a durable workflow body re-executes on every replay — wrap it in a checkpointed step: `await ctx.localStep('name', () => fetch(…))` (recorded once, then replayed).",
      noEngine:
        'Direct `engine.{{method}}(…)` inside a durable workflow body re-executes on every replay — drive the engine from outside the workflow, or use the `ctx` primitives (`ctx.step`, `ctx.startChild`, …) so the call is checkpointed.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        // The global `fetch(...)` only — a bare identifier call. `this.fetch(...)` / `api.fetch(...)`
        // have a receiver and are deliberately left alone (they may well be deterministic wrappers).
        if (callee.type === 'Identifier' && callee.name === 'fetch') {
          if (isInWorkflowBody(node)) context.report({ node, messageId: 'noFetch' });
          return;
        }
        // Raw engine calls: a receiver *named exactly* `engine` (`engine.start(...)`). Name-based on
        // purpose — no type information — so `this.engine.x()` / `workflowEngine.x()` are not
        // flagged here; keeping the match narrow keeps false positives at zero.
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'engine' &&
          callee.property.type === 'Identifier' &&
          isInWorkflowBody(node)
        ) {
          context.report({ node, messageId: 'noEngine', data: { method: callee.property.name } });
        }
      },
    };
  },
});

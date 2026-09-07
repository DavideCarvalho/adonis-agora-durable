import type { TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.js';
import { isInWorkflowBody } from './workflow-body.js';

type MessageId = 'rethrowSignal' | 'insertGuard';

/**
 * True when `node` contains an `await` (or `for await`) in its own async frame — nested functions
 * are their own frames, so their awaits don't count. Only an `await`ed ctx op can unwind the
 * workflow turn with a control-flow signal, so a try over purely synchronous code can never catch
 * one and its catch needs no guard.
 */
function containsAwait(node: TSESTree.Node): boolean {
  if (node.type === 'AwaitExpression') return true;
  if (node.type === 'ForOfStatement' && node.await) return true;
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    return false;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (
        typeof child === 'object' &&
        child !== null &&
        typeof (child as { type?: unknown }).type === 'string' &&
        containsAwait(child as TSESTree.Node)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** True when `node` is (or a block containing) a `throw <param>` statement. */
function rethrowsParam(node: TSESTree.Statement, param: string): boolean {
  if (node.type === 'ThrowStatement') {
    return node.argument.type === 'Identifier' && node.argument.name === param;
  }
  if (node.type === 'BlockStatement') {
    return node.body.some((stmt) => rethrowsParam(stmt, param));
  }
  return false;
}

/** True when `expr` contains a call to `isWorkflowControlFlowSignal(<param>)`. */
function callsSignalPredicate(expr: TSESTree.Expression, param: string): boolean {
  if (
    expr.type === 'CallExpression' &&
    expr.callee.type === 'Identifier' &&
    expr.callee.name === 'isWorkflowControlFlowSignal' &&
    expr.arguments[0]?.type === 'Identifier' &&
    expr.arguments[0].name === param
  ) {
    return true;
  }
  // `isWorkflowControlFlowSignal(e) || e instanceof Foo`-style composites.
  if (expr.type === 'LogicalExpression') {
    return callsSignalPredicate(expr.left, param) || callsSignalPredicate(expr.right, param);
  }
  return false;
}

/**
 * True when the catch body lets the engine's control-flow signals through — either the documented
 * guard (`if (isWorkflowControlFlowSignal(e)) throw e`, possibly composed in a larger condition) or
 * an unconditional top-level `throw e` (everything is rethrown, signals included).
 */
function rethrowsControlFlowSignal(body: TSESTree.BlockStatement, param: string): boolean {
  return body.body.some(
    (stmt) =>
      rethrowsParam(stmt, param) ||
      (stmt.type === 'IfStatement' &&
        callsSignalPredicate(stmt.test, param) &&
        rethrowsParam(stmt.consequent, param)),
  );
}

export const rethrowControlFlowSignals = createRule<[], MessageId>({
  name: 'rethrow-control-flow-signals',
  meta: {
    type: 'problem',
    hasSuggestions: true,
    docs: {
      description:
        "Require catch blocks inside a durable workflow body to rethrow the engine's control-flow signals (suspend / continue-as-new). Swallowing one runs a failure path on what is really a mid-turn unwind, records extra commands into history, and the resumed replay dies with a NonDeterminismError. Guard with `if (isWorkflowControlFlowSignal(e)) throw e` first, or rethrow unconditionally.",
    },
    messages: {
      rethrowSignal:
        "This catch inside a durable workflow body swallows the engine's control-flow signals (suspend / continue-as-new) — the run's suspension breaks silently. Start the catch with `if (isWorkflowControlFlowSignal({{param}})) throw {{param}}` (imported from `@adonis-agora/durable`), or rethrow the error unconditionally.",
      insertGuard:
        'Insert `if (isWorkflowControlFlowSignal({{param}})) throw {{param}};` as the first statement (import it from `@adonis-agora/durable`).',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CatchClause(node) {
        if (!isInWorkflowBody(node)) return;
        // A try over purely synchronous code (`try { JSON.parse(x) } catch { … }`) can never
        // catch a control-flow signal — see `containsAwait` — so its catch needs no guard.
        if (!containsAwait(node.parent.block)) return;
        // `catch { … }` / `catch ({ message }) { … }` cannot rethrow the signal at all.
        const param = node.param?.type === 'Identifier' ? node.param.name : undefined;
        if (param !== undefined && rethrowsControlFlowSignal(node.body, param)) return;
        const paramName = param ?? 'error';
        context.report({
          node,
          messageId: 'rethrowSignal',
          data: { param: paramName },
          // The guard needs a named param to rethrow, so only suggest when one exists.
          suggest:
            param === undefined
              ? []
              : [
                  {
                    messageId: 'insertGuard',
                    data: { param },
                    fix: (fixer) =>
                      fixer.insertTextAfterRange(
                        [node.body.range[0], node.body.range[0] + 1],
                        ` if (isWorkflowControlFlowSignal(${param})) throw ${param};`,
                      ),
                  },
                ],
        });
      },
    };
  },
});

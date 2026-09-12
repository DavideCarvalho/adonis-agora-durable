import type { TSESTree } from '@typescript-eslint/utils';

/**
 * A function/arrow passed as an argument to a CHECKPOINT-CALLBACK primitive — `ctx.localStep(...)`,
 * `ctx.task(...)` or `ctx.sideEffect(...)` — whose body is run once and checkpointed, so
 * non-determinism inside it is fine (only the orchestration body must be pure). NOTE: `ctx.step` is
 * NOT here — it is now the always-DISPATCHED step (its 2nd arg is data, not a callback), so a
 * function reaching it is not a checkpointed body and the walk should not stop at it.
 */
export function isCheckpointedCallback(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn as never)) return false;
  const callee = call.callee;
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'localStep' ||
      callee.property.name === 'task' ||
      callee.property.name === 'sideEffect')
  );
}

/** The receiver looks like a workflow engine — `engine` / `workflowEngine` / `this.engine` etc. So
 *  `engine.register(...)` is recognized but an unrelated `someRegistry.register(...)` is not. */
export function isEngineReceiver(object: TSESTree.Expression | TSESTree.Super): boolean {
  const name =
    object.type === 'Identifier'
      ? object.name
      : object.type === 'MemberExpression' && object.property.type === 'Identifier'
        ? object.property.name
        : undefined;
  return name !== undefined && /engine/i.test(name);
}

/**
 * True for the workflow body function passed to `engine.register(name, version, fn)` (or
 * `registerRemote`/`registerEntity`) — Agora's function form of a workflow. The deterministic
 * orchestration body is the function/arrow argument of that call, and the receiver must read as a
 * workflow engine, so non-determinism inside it must be flagged (while an unrelated `.register` on
 * some other object is left alone).
 */
export function isRegisterWorkflowBody(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || !call.arguments.includes(fn as never)) return false;
  const callee = call.callee;
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'register' ||
      callee.property.name === 'registerRemote' ||
      callee.property.name === 'registerEntity') &&
    isEngineReceiver(callee.object)
  );
}

/**
 * True when `classNode` is a durable workflow class — a `BaseWorkflow` subclass, or any class
 * carrying a `static workflow = { name, … }` config (the authoring form the engine registers). Its
 * `run` method is the deterministic orchestration body the rules guard.
 */
export function isWorkflowClass(classNode: TSESTree.Node | undefined): boolean {
  if (
    !classNode ||
    (classNode.type !== 'ClassDeclaration' && classNode.type !== 'ClassExpression')
  ) {
    return false;
  }
  // `class X extends BaseWorkflow { … }`
  if (classNode.superClass?.type === 'Identifier' && classNode.superClass.name === 'BaseWorkflow') {
    return true;
  }
  // `static workflow = { name, … }` on the class body.
  return classNode.body.body.some(
    (member) =>
      member.type === 'PropertyDefinition' &&
      member.static &&
      member.key.type === 'Identifier' &&
      member.key.name === 'workflow',
  );
}

/**
 * True when `node` sits lexically inside a workflow's deterministic orchestration body — either the
 * `run` method of a workflow class (`BaseWorkflow` subclass / `static workflow` config), or the
 * function passed to `engine.register(...)`.
 * Returns false the moment the walk crosses a checkpoint-callback boundary — `ctx.localStep`,
 * `ctx.task` or `ctx.sideEffect` (see `isCheckpointedCallback`) — since that body is checkpointed
 * (run once) and so may be non-deterministic. `ctx.step` is not one of them.
 */
export function isInWorkflowBody(node: TSESTree.Node): boolean {
  let cur: TSESTree.Node | undefined = node;
  while (cur) {
    if (cur.type === 'ArrowFunctionExpression' || cur.type === 'FunctionExpression') {
      // Crossing a checkpoint-callback boundary means the call is inside a checkpointed step — not
      // the deterministic orchestration body — so don't flag it.
      if (isCheckpointedCallback(cur)) return false;
      // The function form: the body passed to `engine.register(name, version, fn)`.
      if (isRegisterWorkflowBody(cur)) return true;
    }
    // The class form: the `run` method of a workflow class.
    if (
      cur.type === 'MethodDefinition' &&
      cur.key.type === 'Identifier' &&
      cur.key.name === 'run' &&
      isWorkflowClass(cur.parent?.parent) // MethodDefinition → ClassBody → Class
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

/** The receiver name of a member call: `crypto` for `crypto.x()` and `globalThis.crypto.x()`. */
export function receiverName(object: TSESTree.Expression | TSESTree.Super): string | undefined {
  if (object.type === 'Identifier') return object.name;
  if (object.type === 'MemberExpression' && object.property.type === 'Identifier') {
    return object.property.name;
  }
  return undefined;
}

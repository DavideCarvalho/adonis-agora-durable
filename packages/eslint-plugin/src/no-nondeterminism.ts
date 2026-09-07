import { createRule } from './create-rule.js';
import { isInWorkflowBody, receiverName } from './workflow-body.js';

type MessageId =
  | 'useNow'
  | 'useRandom'
  | 'useUuid'
  | 'useUuidImport'
  | 'useNowDate'
  | 'useNowDateCall'
  | 'useEnv';

/** The globals whose members are non-deterministic — for cheap `const d = Date` alias tracking. */
const BANNED_GLOBALS = new Set(['Date', 'Math', 'crypto', 'performance']);

export const noNondeterminism = createRule<[], MessageId>({
  name: 'no-nondeterminism',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow non-deterministic sources (Date.now, Math.random, new Date, Date(), crypto.randomUUID, imported randomUUID, process.env) inside a durable workflow body — they differ across replays and silently corrupt a durable run. Use ctx.now() for a timestamp or ctx.sideEffect(() => …) to capture any other generated value once.',
    },
    messages: {
      useNow:
        'Non-deterministic `{{call}}` inside a durable workflow body — use `ctx.now()` (recorded once, then replayed).',
      useRandom:
        'Non-deterministic `Math.random()` inside a durable workflow body — use `ctx.sideEffect(() => Math.random())` (captured once, then replayed).',
      useUuid:
        'Non-deterministic `crypto.randomUUID()` inside a durable workflow body — use `ctx.sideEffect(() => crypto.randomUUID())` (captured once, then replayed).',
      useUuidImport:
        'Non-deterministic `{{name}}()` (a `randomUUID` import from `node:crypto`) inside a durable workflow body — use `ctx.sideEffect(() => {{name}}())` (captured once, then replayed).',
      useNowDate:
        'Non-deterministic `new Date()` inside a durable workflow body — use `new Date(await ctx.now())`.',
      useNowDateCall:
        'Non-deterministic `Date()` inside a durable workflow body — use `new Date(await ctx.now())`.',
      useEnv:
        'Deploy-varying `process.env` read inside a durable workflow body — a redeploy changes the value mid-run and the replayed path diverges. Read it inside `ctx.sideEffect(() => process.env.X)` (captured once, then replayed) or resolve config outside the workflow.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    // Local names bound to `randomUUID` from `node:crypto`/`crypto` — `import { randomUUID }` and
    // its aliased form `import { randomUUID as uuid }`.
    const importedRandomUuid = new Set<string>();
    // `const d = Date` — alias name → the banned global it was assigned from. Deliberately shallow:
    // same-file `const` initialized from the bare global, no data-flow analysis.
    const globalAliases = new Map<string, string>();

    /** Resolve a member-call receiver through the cheap alias map: `d.now()` → `Date`. */
    const resolveReceiver = (name: string | undefined): string | undefined =>
      name === undefined ? undefined : (globalAliases.get(name) ?? name);

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'crypto' && node.source.value !== 'node:crypto') return;
        for (const spec of node.specifiers) {
          // `import { randomUUID } from 'node:crypto'` / `import { randomUUID as uuid } …`.
          if (
            spec.type === 'ImportSpecifier' &&
            spec.imported.type === 'Identifier' &&
            spec.imported.name === 'randomUUID'
          ) {
            importedRandomUuid.add(spec.local.name);
          }
          // `import crypto from 'node:crypto'` / `import * as c from 'node:crypto'` — the local
          // name is a `crypto` receiver, so `c.randomUUID()` resolves like `crypto.randomUUID()`.
          if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
            globalAliases.set(spec.local.name, 'crypto');
          }
        }
      },
      VariableDeclarator(node) {
        // `const d = Date` — remember the alias so `d.now()` is caught below. `let`/`var` are
        // skipped: they can be reassigned, and this is deliberately not a data-flow analysis.
        if (
          node.init?.type === 'Identifier' &&
          BANNED_GLOBALS.has(node.init.name) &&
          node.id.type === 'Identifier' &&
          node.parent.type === 'VariableDeclaration' &&
          node.parent.kind === 'const'
        ) {
          globalAliases.set(node.id.name, node.init.name);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        // Bare identifier calls: `Date()` (the current-time string) and an imported `randomUUID()`.
        if (callee.type === 'Identifier') {
          if (resolveReceiver(callee.name) === 'Date' && isInWorkflowBody(node)) {
            context.report({ node, messageId: 'useNowDateCall' });
          } else if (importedRandomUuid.has(callee.name) && isInWorkflowBody(node)) {
            context.report({ node, messageId: 'useUuidImport', data: { name: callee.name } });
          }
          return;
        }
        if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') return;
        const prop = callee.property.name;
        const obj = resolveReceiver(receiverName(callee.object));
        const isBanned =
          ((obj === 'Date' || obj === 'performance') && prop === 'now') ||
          (obj === 'Math' && prop === 'random') ||
          (obj === 'crypto' && prop === 'randomUUID');
        if (!isBanned || !isInWorkflowBody(node)) return;
        if (prop === 'random') context.report({ node, messageId: 'useRandom' });
        else if (prop === 'randomUUID') context.report({ node, messageId: 'useUuid' });
        else context.report({ node, messageId: 'useNow', data: { call: `${obj}.now()` } });
      },
      NewExpression(node) {
        const name =
          node.callee.type === 'Identifier'
            ? resolveReceiver(node.callee.name)
            : /* `new d()` via alias resolves too */ undefined;
        if (name === 'Date' && node.arguments.length === 0 && isInWorkflowBody(node)) {
          context.report({ node, messageId: 'useNowDate' });
        }
      },
      MemberExpression(node) {
        // `process.env` / `process.env.X` — flag the `process.env` read itself (once per read).
        if (
          node.property.type === 'Identifier' &&
          node.property.name === 'env' &&
          receiverName(node.object) === 'process' &&
          isInWorkflowBody(node)
        ) {
          context.report({ node, messageId: 'useEnv' });
        }
      },
    };
  },
});

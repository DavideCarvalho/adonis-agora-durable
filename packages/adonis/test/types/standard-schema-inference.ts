/**
 * Compile-time guards for the Standard Schema surface (checked by `tsc -p tsconfig.tests.json`, no
 * runtime assertions): `defineStep` infers its handler/ref types from any Standard Schema (zod,
 * valibot, arktype), `WorkflowCtx<A>` narrows `upsertSearchAttributes`, a nested-object schema can't
 * be declared as search attributes, and the untyped forms keep compiling exactly as before.
 */
import { type } from 'arktype';
import * as v from 'valibot';
import { z } from 'zod';
import { BaseWorkflow } from '../../src/base-workflow.js';
import type { WorkflowEngine } from '../../src/engine.js';
import type {
  InferSearchAttributes,
  SearchAttributes,
  SearchAttributesSchema,
  WorkflowCtx,
} from '../../src/interfaces.js';
import { attributesOf } from '../../src/search-attributes-schema.js';
import type { StandardSchemaV1 } from '../../src/standard-schema.js';
import type { StepRef } from '../../src/step-name-symbol.js';
import { defineStep, Step } from '../../src/step-ref.js';
import type { WorkflowOptions } from '../../src/workflow-ref.js';

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
function assertType<_T extends true>(): void {}

// --- defineStep inference --------------------------------------------------------------------------

// valibot: handler receives the schema OUTPUT (coerced number); the ref takes the schema INPUT.
export const vStep = defineStep('v', async (input) => ({ doubled: input.n * 2 }), {
  input: v.object({ n: v.pipe(v.string(), v.transform(Number)) }),
});
assertType<Equal<typeof vStep, StepRef<{ n: string }, { doubled: number }>>>();

// zod: input + output schemas — the ref resolves to the output schema's OUTPUT.
export const zStep = defineStep('z', async (input) => String(input.id), {
  input: z.object({ id: z.number() }),
  output: z.string().transform((s) => s.length),
});
assertType<Equal<typeof zStep, StepRef<{ id: number }, number>>>();

// arktype: output-only — input comes from the annotation as before.
export const aStep = defineStep('a', async (input: { name: string }) => input.name, {
  output: type('string'),
});
assertType<Equal<typeof aStep, StepRef<{ name: string }, string>>>();

// No schema: exactly the previous inference.
export const plain = defineStep('p', async (input: { a: number }) => input.a, { retries: 2 });
assertType<Equal<typeof plain, StepRef<{ a: number }, number>>>();

// The handler body is checked against the inferred input.
export const wrongBody = defineStep(
  'w',
  // @ts-expect-error — `input.n` is a number per the schema; `.toUpperCase` doesn't exist on it
  async (input) => input.n.toUpperCase(),
  { input: v.object({ n: v.number() }) },
);

// Back-compat: an ANNOTATED handler is never re-typed — a config whose schema disagrees with the
// annotation falls back to the pre-Standard-Schema overload (types from the handler), so existing
// code keeps compiling; the schema is still enforced at runtime.
export const annotated = defineStep('r', async (input: { id: string }) => input.id, {
  input: z.unknown(),
});
assertType<Equal<typeof annotated, StepRef<{ id: string }, string>>>();

// ctx.step type-checks the call-site input against the schema's INPUT type.
export async function _ctxStep(ctx: WorkflowCtx): Promise<void> {
  const out: { doubled: number } = await ctx.step(vStep, { n: '2' });
  void out;
  // @ts-expect-error — the ref takes `{ n: string }` (the schema's input), not a number
  await ctx.step(vStep, { n: 2 });
}

// @Step accepts any Standard Schema.
export class Svc {
  @Step({ input: v.object({ n: v.number() }), output: type('number') })
  run(input: { n: number }) {
    return input.n;
  }
}

// --- workflow inputSchema / searchAttributes config ------------------------------------------------

export const zodOpts: WorkflowOptions = { name: 'a', inputSchema: z.object({ a: z.string() }) };
export const valibotOpts: WorkflowOptions = { name: 'b', inputSchema: v.object({ a: v.string() }) };
export const arkOpts: WorkflowOptions = { name: 'c', inputSchema: type({ a: 'string' }) };

declare const engine: WorkflowEngine;
engine.register('w', '1', async () => 1, {
  inputSchema: v.number(),
  searchAttributesSchema: z.object({ tier: z.enum(['free', 'pro']), n: z.number().optional() }),
});

// --- typed search attributes -----------------------------------------------------------------------

const orderAttrs = v.object({ tier: v.picklist(['free', 'pro']), amount: v.optional(v.number()) });
type OrderAttrs = InferSearchAttributes<typeof orderAttrs>;
declare const typedCtx: WorkflowCtx<OrderAttrs>;
declare const defaultCtx: WorkflowCtx;

export async function _typedUpserts(): Promise<void> {
  await typedCtx.upsertSearchAttributes({ tier: 'pro' });
  await typedCtx.upsertSearchAttributes({ amount: 42 });
  await typedCtx.upsertSearchAttributes({});
  // @ts-expect-error — 'enterprise' is not in the declared tier union
  await typedCtx.upsertSearchAttributes({ tier: 'enterprise' });
  // Back-compat: a bare WorkflowCtx accepts any SearchAttributes bag.
  const anything: SearchAttributes = { anything: 'goes', n: 1, ok: true };
  await defaultCtx.upsertSearchAttributes(anything);
}

// A typed ctx is still a `WorkflowCtx` for code taking the untyped one, and vice-versa (method params).
export const widened: WorkflowCtx = typedCtx;
engine.register('typed', '1', async (ctx: WorkflowCtx<OrderAttrs>) => {
  await ctx.upsertSearchAttributes({ tier: 'free' });
});

// A nested-object output is not search-attribute-shaped.
export function _rejectsNested(): SearchAttributesSchema {
  // @ts-expect-error — `{ meta: { x: string } }` doesn't extend the flat search-attribute shape
  return z.object({ meta: z.object({ x: z.string() }) });
}

// attributesOf reads back typed from the class's `run(ctx: WorkflowCtx<A>)` annotation.
export class Checkout extends BaseWorkflow {
  static override workflow = { name: 'checkout', searchAttributes: orderAttrs };
  async run(ctx: WorkflowCtx<OrderAttrs>, _input: { id: string }) {
    await ctx.upsertSearchAttributes({ tier: 'pro' });
  }
}
const read = attributesOf(Checkout, {});
assertType<Equal<typeof read, OrderAttrs>>();
export const untypedRead: SearchAttributes = attributesOf(
  class extends BaseWorkflow {
    async run(_ctx: WorkflowCtx) {}
  },
  {},
);

// The vendored type matches the shape every library implements.
export const asStandard: StandardSchemaV1<unknown, { a: string }> = type({ a: 'string' });

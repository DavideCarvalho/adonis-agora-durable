import type {
  InferSearchAttributes,
  SearchAttributes,
  SearchAttributesSchema,
  WorkflowCtx,
} from './interfaces.js';
import { type WorkflowClass, workflowMeta } from './workflow-ref.js';

/**
 * Read a run's `searchAttributes` through a {@link SearchAttributesSchema}, typed to the schema's
 * inferred output. **Safe-parse semantics, deliberately lenient** — unlike
 * `ctx.upsertSearchAttributes` (strict: an invalid merge throws), a failed validation here returns
 * `{}` rather than throwing: `run.searchAttributes` may predate the schema (an older deploy wrote it
 * under a looser or absent schema), and a dashboard/read path crashing on old history is worse than
 * it reporting no typed attributes for that run. Write-time enforcement keeps NEW writes conformant.
 *
 * The schema's `validate` must be synchronous (same constraint as the write side) — one returning a
 * `Promise` throws a clear error rather than being silently awaited or treated as a failure.
 *
 * ```ts
 * const attrs = readSearchAttributes(orderAttrs, (await store.getRun(runId)) ?? {})
 * ```
 */
export function readSearchAttributes<S extends SearchAttributesSchema>(
  schema: S,
  run: { searchAttributes?: SearchAttributes | null | undefined },
): InferSearchAttributes<S> {
  const result = schema['~standard'].validate(run.searchAttributes ?? {});
  if (result instanceof Promise) {
    throw new TypeError(
      "readSearchAttributes: schema validation must be synchronous (the searchAttributes schema's " +
        '`~standard.validate` returned a Promise) — async Standard Schema validators are not supported.',
    );
  }
  // Lenient by design (see above). Cast rather than `Partial<…>` to keep destructuring ergonomic;
  // callers reading untrusted history should still treat every field as possibly absent.
  if (result.issues) return {} as InferSearchAttributes<S>;
  return result.value as InferSearchAttributes<S>;
}

/**
 * The search-attributes shape a workflow class declares — extracted from its `run` method's
 * `ctx: WorkflowCtx<A>` annotation (the same structural idiom as `WorkflowInputOf`/`WorkflowOutputOf`).
 * A class whose `run` leaves `ctx` untyped (or bare `WorkflowCtx`) resolves to {@link SearchAttributes}.
 */
export type WorkflowAttributesOf<C> = C extends abstract new (
  ...args: never[]
) => {
  run(ctx: WorkflowCtx<infer A>, input: never): unknown;
}
  ? A
  : SearchAttributes;

/**
 * Read a run's search attributes **by workflow class**, with the schema resolved from that class's
 * `static workflow = { searchAttributes }` config — the workflow is the one place the schema lives,
 * readers never re-import it. Typed from the class's `run(ctx: WorkflowCtx<A>, …)` annotation (see
 * {@link WorkflowAttributesOf}). Same lenient semantics as {@link readSearchAttributes}.
 *
 * @throws if `workflow` has no `static workflow` config, or declares no `searchAttributes` schema.
 *
 * ```ts
 * const attrs = attributesOf(CheckoutWorkflow, (await store.getRun(runId)) ?? {}) // OrderAttrs
 * ```
 */
export function attributesOf<C extends WorkflowClass>(
  workflow: C,
  run: { searchAttributes?: SearchAttributes | null | undefined },
): WorkflowAttributesOf<C> {
  const meta = workflowMeta(workflow);
  if (!meta) {
    throw new Error(
      `attributesOf: ${workflow.name} is not a workflow class — does it declare \`static workflow = { name, searchAttributes }\`?`,
    );
  }
  if (!meta.searchAttributes) {
    throw new Error(
      `attributesOf: workflow '${meta.name}' declares no searchAttributes schema — reading attributes by class requires \`static workflow = { name: '${meta.name}', searchAttributes: mySchema }\`.`,
    );
  }
  return readSearchAttributes(meta.searchAttributes, run) as WorkflowAttributesOf<C>;
}

import { type SchemaValidationCode, SchemaValidationError } from './errors.js';

/**
 * Vendored subset of the Standard Schema spec (https://standardschema.dev) — the `~standard`
 * property protocol implemented by zod (3.24+ / 4), valibot, arktype, effect schema and others.
 * Vendored (rather than taken as a dependency) as the spec recommends, so the package stays free of
 * any schema library at runtime: the interface is types only, erased by the build. Source:
 * https://github.com/standard-schema/standard-schema (MIT) — trimmed to the `StandardSchemaV1` shape
 * this package consumes, identical to the copy in the NestJS sibling (`@dudousxd/nestjs-durable-core`).
 *
 * Used by `@Step({ input, output })` / `defineStep`, `register(..., { inputSchema })` /
 * `static workflow = { inputSchema }` and the typed `searchAttributes` schema, so each accepts
 * whichever schema library the app already uses.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Validates unknown input values. */
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** The result interface of the validate function. */
  type Result<Output> = SuccessResult<Output> | FailureResult;

  /** The result interface if validation succeeds. */
  interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** A falsy value for `issues` indicates success. */
    readonly issues?: undefined;
  }

  /** The result interface if validation fails. */
  interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: ReadonlyArray<Issue>;
  }

  /** The issue interface of the failure output. */
  interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** The path segment interface of the issue. */
  interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }

  /** The Standard Schema types interface. */
  interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }

  /** Infers the input type of a Standard Schema. */
  type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  /** Infers the output type of a Standard Schema. */
  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}

/**
 * Validate `value` against any Standard Schema and return the schema's OUTPUT value (parsed /
 * coerced / defaulted — e.g. zod's `.transform`, valibot's `pipe`, arktype morphs). Both a sync and
 * an async (`Promise`-returning) `~standard.validate` are supported. On failure throws a
 * {@link SchemaValidationError} — a non-retryable `FatalError` carrying the issues in `details`, so a
 * bad payload fails fast instead of being retried forever.
 *
 * `label` names what was validated in the error message, e.g. `step "billing:charge" input`. `code`
 * is the error's code: `invalid_input` / `invalid_output` for an input or output schema, and
 * `schema_validation` (the default) otherwise.
 */
export async function validateStandard<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  label: string,
  code?: SchemaValidationCode,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const result = await schema['~standard'].validate(value);
  if (result.issues) throw new SchemaValidationError(label, result.issues, code);
  return result.value as StandardSchemaV1.InferOutput<S>;
}

/**
 * Synchronous {@link validateStandard}, for call sites that must not await a validator (the typed
 * search-attributes write, where an async refinement could make replay nondeterministic). A schema
 * whose `validate` returns a `Promise` throws a clear error instead of being silently awaited.
 */
export function validateStandardSync<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  label: string,
  code?: SchemaValidationCode,
): StandardSchemaV1.InferOutput<S> {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new TypeError(
      `${label}: schema validation must be synchronous (the schema's \`~standard.validate\` returned a Promise) — drop any async refinement from it.`,
    );
  }
  if (result.issues) throw new SchemaValidationError(label, result.issues, code);
  return result.value as StandardSchemaV1.InferOutput<S>;
}

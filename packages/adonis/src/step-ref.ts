import type { BackoffStrategy, StepLogger } from './interfaces.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type StepConfig,
  type StepRef,
} from './step-name-symbol.js';

/**
 * The full metadata a `@Step` / {@link defineStep} stamps on a step handler for discovery: its
 * resolved routing `name` plus the opt-in runtime Standard Schemas (zod, valibot, arktype, …) an
 * authoring layer attached. Stamped
 * under {@link DURABLE_STEP_META} on the handler function so step discovery can wrap it with
 * validation at the serve boundary. A global-registry symbol so it survives duplicate copies.
 */
export const DURABLE_STEP_META: unique symbol = Symbol.for('@agora/durable:step-meta');

/** Discovery metadata a decorated/`defineStep` handler carries: routing name + optional schemas. */
export interface DurableStepMeta {
  /** The resolved routing name — derived (`Class.method`) or explicit, always present. */
  name: string;
  /** Opt-in runtime input schema, validated when the handler is served. Absent on a bare `@Step()`. */
  input?: StandardSchemaV1 | undefined;
  /** Opt-in runtime output schema, validated before the handler's result is handed back. */
  output?: StandardSchemaV1 | undefined;
}

/** Options for the object call form of {@link Step} / {@link defineStep}. */
export interface StepDecoratorOptions {
  /** Explicit routing name, overriding the derived `Class.method`. */
  name?: string;
  /** Runtime input schema — any Standard Schema (zod, valibot, arktype, …) — validated at the serve
   *  boundary (opt-in — a bare `@Step()` skips it). The handler receives the schema's OUTPUT value. */
  input?: StandardSchemaV1;
  /** Runtime output schema (any Standard Schema), validated before the result is returned (opt-in).
   *  The caller receives the schema's OUTPUT value. */
  output?: StandardSchemaV1;
  /** Def-level policy: max attempts before the step (and run) fails. Read by `ctx.step` via `stepConfigOf`. */
  retries?: number;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt). */
  backoff?: BackoffStrategy;
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. */
  backoffMs?: number;
  /** Upper bound on the (exponential) backoff delay. */
  backoffMaxMs?: number;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. */
  jitter?: boolean;
  /** Liveness window for the dispatched step (ms): presume the worker dead and re-dispatch on timeout. */
  timeoutMs?: number;
  /** Pre-first-heartbeat liveness window (queue wait + pickup; see `StepOptions.pickupTimeoutMs`).
   *  Defaults to `timeoutMs`. */
  pickupTimeoutMs?: number;
  /** Capabilities a live worker must advertise to run this step (design §7.5). The control-plane
   *  routes only to workers whose handshake descriptor advertises every name here; if none is live +
   *  protocol-compatible the run parks `blocked` with a precise reason. Absent/empty = runs anywhere. */
  requires?: string[];
}

/** {@link defineStep}'s options minus the schemas — the overloads add `input`/`output` typed. */
export type DefineStepOptions = Omit<StepDecoratorOptions, 'name' | 'input' | 'output'>;

/** Build the {@link StepConfig} to stamp from options — omitting every unset field, so a bare
 *  `@Step()` (or one with only `name`/`input`/`output`) stamps nothing and leaves `ctx.step` reading
 *  only a per-call `opts` override. */
function stepConfigFrom(options: StepDecoratorOptions): StepConfig | undefined {
  const config: StepConfig = {};
  if (options.retries !== undefined) config.retries = options.retries;
  if (options.backoff !== undefined) config.backoff = options.backoff;
  if (options.backoffMs !== undefined) config.backoffMs = options.backoffMs;
  if (options.backoffMaxMs !== undefined) config.backoffMaxMs = options.backoffMaxMs;
  if (options.jitter !== undefined) config.jitter = options.jitter;
  if (options.timeoutMs !== undefined) config.timeoutMs = options.timeoutMs;
  if (options.pickupTimeoutMs !== undefined) config.pickupTimeoutMs = options.pickupTimeoutMs;
  if (options.requires !== undefined) config.requires = options.requires;
  return Object.keys(config).length > 0 ? config : undefined;
}

/** Stamp the shared cross-package name/config/meta keys onto a step handler function. */
function stamp(fn: object, meta: DurableStepMeta, config: StepConfig | undefined): void {
  (fn as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = meta.name;
  (fn as { [DURABLE_STEP_META]?: DurableStepMeta })[DURABLE_STEP_META] = meta;
  if (config !== undefined) {
    (fn as { [DURABLE_STEP_CONFIG]?: StepConfig })[DURABLE_STEP_CONFIG] = config;
  }
}

/**
 * Marks a class method as a durable **step handler**. A dispatched task is routed to it BY NAME —
 * `ctx.step(this.svc.method, input)` reads that same name off the method reference (the shared
 * `DURABLE_STEP_NAME` stamp), so there is no separately-declared def linking a call site to a
 * handler. The method's single argument is the step input (plus an optional `StepLogger` 2nd arg);
 * its return is the step output.
 *
 * Three call forms:
 * - `@Step()` — bare: the routing name is DERIVED as `` `${ClassName}.${method}` `` — refactor-safe.
 * - `@Step('custom:name')` — explicit name override (a stable cross-runtime contract).
 * - `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?, backoffMaxMs?, jitter?,
 *   timeoutMs? })` — optional name override, opt-in RUNTIME Standard Schemas (zod, valibot,
 *   arktype, … — validated at the serve boundary by step discovery; a failure is a non-retryable
 *   `SchemaValidationError`), and a def-level durable-retry/liveness policy `ctx.step` reads via
 *   `stepConfigOf` (a per-call `opts` overrides it field-by-field).
 */
export function Step(nameOrOptions?: string | StepDecoratorOptions): MethodDecorator {
  return ((target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const options: StepDecoratorOptions =
      typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {});
    const ctorName = (target as { constructor?: { name?: string } })?.constructor?.name ?? 'Step';
    const name = options.name ?? `${ctorName}.${String(propertyKey)}`;
    const value = descriptor.value;
    if (typeof value !== 'function') {
      throw new Error(`@Step can only decorate a method (${ctorName}.${String(propertyKey)})`);
    }
    const meta: DurableStepMeta = {
      name,
      ...(options.input ? { input: options.input } : {}),
      ...(options.output ? { output: options.output } : {}),
    };
    stamp(value, meta, stepConfigFrom(options));
  }) as MethodDecorator;
}

/**
 * Build a durable step handler WITHOUT a class/decorator: stamps `fn` with the routing `name` (and
 * optional Standard Schemas + dispatch policy) so it works as a typed {@link StepRef} for
 * `ctx.step(fn, input)` AND is discoverable/registerable by name. The cross-runtime baseline — pass
 * the returned ref to `ctx.step`, or register it on a transport via `registerStep`.
 *
 * ```ts
 * export const charge = defineStep('billing:charge', async (input: ChargeInput) => { ... })
 * ```
 *
 * With an `input` / `output` Standard Schema the types are INFERRED from it: the handler receives
 * the input schema's output type (parsed/coerced), and the returned ref takes the input schema's
 * input type and resolves to the output schema's output type — no hand-written annotation needed.
 *
 * ```ts
 * const charge = defineStep('billing:charge', async (input) => ({ id: `ch_${input.amount}` }), {
 *   input: v.object({ amount: v.number() }), // valibot, zod, arktype, …
 * })
 * ```
 */
export function defineStep<SI extends StandardSchemaV1, SO extends StandardSchemaV1>(
  name: string,
  fn: (
    input: StandardSchemaV1.InferOutput<SI>,
    log: StepLogger,
  ) => StandardSchemaV1.InferInput<SO> | Promise<StandardSchemaV1.InferInput<SO>>,
  config: DefineStepOptions & { input: SI; output: SO },
): StepRef<StandardSchemaV1.InferInput<SI>, StandardSchemaV1.InferOutput<SO>>;
export function defineStep<SI extends StandardSchemaV1, TOutput>(
  name: string,
  fn: (input: StandardSchemaV1.InferOutput<SI>, log: StepLogger) => TOutput | Promise<TOutput>,
  config: DefineStepOptions & { input: SI },
): StepRef<StandardSchemaV1.InferInput<SI>, TOutput>;
export function defineStep<TInput, SO extends StandardSchemaV1>(
  name: string,
  fn: (
    input: TInput,
    log: StepLogger,
  ) => StandardSchemaV1.InferInput<SO> | Promise<StandardSchemaV1.InferInput<SO>>,
  config: DefineStepOptions & { output: SO },
): StepRef<TInput, StandardSchemaV1.InferOutput<SO>>;
export function defineStep<TInput, TOutput>(
  name: string,
  fn: (input: TInput, log: StepLogger) => TOutput | Promise<TOutput>,
  config?: Omit<StepDecoratorOptions, 'name'>,
): StepRef<TInput, TOutput>;
export function defineStep(
  name: string,
  fn: (input: never, log: StepLogger) => unknown,
  config?: Omit<StepDecoratorOptions, 'name'>,
): StepRef<unknown, unknown> {
  const meta: DurableStepMeta = {
    name,
    ...(config?.input ? { input: config.input } : {}),
    ...(config?.output ? { output: config.output } : {}),
  };
  stamp(fn, meta, stepConfigFrom({ ...config, name }));
  return fn as unknown as StepRef<unknown, unknown>;
}

/** Read the {@link DurableStepMeta} a `@Step`/`defineStep` stamped on a handler, or `undefined`. */
export function stepMetaOf(ref: unknown): DurableStepMeta | undefined {
  if (typeof ref !== 'function' && typeof ref !== 'object') return undefined;
  return (ref as { [DURABLE_STEP_META]?: DurableStepMeta } | null)?.[DURABLE_STEP_META];
}

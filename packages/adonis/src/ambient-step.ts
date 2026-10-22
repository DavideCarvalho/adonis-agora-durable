import { AsyncLocalStorage } from 'node:async_hooks';
import type { StepLogger } from './interfaces.js';

/**
 * The ambient step logger: an `AsyncLocalStorage` installed around every execution of a step body,
 * local (`ctx.step`) and remote (`runStepHandler`, on a worker) alike, so code deep inside a step can
 * record events without the {@link StepLogger} being threaded through every signature on the way
 * down. The TypeScript twin of the Python SDK's `current_step()`.
 *
 * One storage per PROCESS, not per copy of this package: it lives on `globalThis` under a
 * `Symbol.for` key, so a dependency tree carrying duplicate copies still shares one ambient logger.
 */
const STORAGE_KEY = Symbol.for('@agora/durable:ambient-step-logger');

type GlobalWithStorage = typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<StepLogger>;
};

const globalRef = globalThis as GlobalWithStorage;
if (!globalRef[STORAGE_KEY]) globalRef[STORAGE_KEY] = new AsyncLocalStorage<StepLogger>();
const storage: AsyncLocalStorage<StepLogger> = globalRef[STORAGE_KEY];

/**
 * Run `fn` with `logger` as the ambient step logger. Internal: wraps every step body with the SAME
 * logger instance the body receives as its argument, so an event emitted ambiently and one emitted
 * through the argument land in the same event list and are checkpointed together. Concurrent steps
 * each see their own.
 */
export function runInStepLogger<T>(logger: StepLogger, fn: () => T): T {
  return storage.run(logger, fn);
}

/**
 * The {@link StepLogger} of the step body executing on this async path, or `undefined` outside one —
 * for code that cannot take a logger parameter (a batch inserter, an HTTP client a few calls below
 * the step):
 *
 * ```ts
 * import { currentStep } from '@adonis-agora/durable'
 *
 * currentStep()?.info('inserted batch', { rows })
 * ```
 *
 * The optional chain is the contract: outside a step there is nothing to record to, and the same
 * helper keeps working in a unit test with no durable run around it.
 */
export function currentStep(): StepLogger | undefined {
  return storage.getStore();
}

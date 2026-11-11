// Resolves `@adonis-agora/durable/diagnostics` to this package's TypeScript source, so the
// `transports.durable()` of a real `@adonis-agora/diagnostics` loads the module under test (and
// the same `WorkflowEngine` class the child binds) instead of a published build.
const SELF = new URL('../../src/diagnostics/index.ts', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@adonis-agora/durable/diagnostics') return { url: SELF, shortCircuit: true };
  return next(specifier, context);
}

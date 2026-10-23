/**
 * Geradores de suite de conformance para quem implementa um backend/store customizado. Ao
 * contrario do resto de `testing-kit` (harness, assertions, replay, injecao de falhas), estes dois
 * modulos usam `describe`/`it` do vitest para GERAR a suite -- entao exigem vitest de verdade, sem
 * meio-termo. Por isso vivem num subpath proprio (`@adonis-agora/durable/testing/conformance`),
 * separado do barrel principal `@adonis-agora/durable/testing`: assim `createTestEngine` e as
 * asserts continuam importaveis por quem usa outro test runner (ex.: Japa), e so quem
 * explicitamente precisa rodar a conformance contract (que legitimamente exige vitest) paga esse
 * custo.
 */
export * from './admission-backend-conformance.js';
export * from './run-dispatch-contract.js';
export * from './state-store-conformance.js';

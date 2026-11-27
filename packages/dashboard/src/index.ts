/**
 * `@adonis-agora/durable-dashboard` ships no JavaScript API: it is the pre-built console SPA
 * (`dist/spa`) that `@adonis-agora/durable/dashboard` serves. Configure it from that subpath
 * (`defineConfig`, `authorizeByToken` in `config/durable_dashboard.ts`).
 *
 * This module is the package's committed type entry, so tooling that resolves the package from
 * source (TanStack Intent's skill-example typecheck) finds one. It is not built or published.
 */
export {};

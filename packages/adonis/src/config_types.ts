import type { BaseDurableConfig } from './define_config.js';

/**
 * Role-discriminated config members for `config/durable.ts` (see
 * `docs/superpowers/specs/2026-07-17-store-less-cluster-design.md` §5). The engine's topology is
 * selected explicitly by `role` — never inferred — and TypeScript narrows the accepted shape on the
 * `role` literal so an invalid combination (a store-less `tenant` pod that names a store) is a
 * **compile error**, not a runtime assertion.
 *
 * These members are additive over {@link BaseDurableConfig} (today's field-for-field config): every
 * existing field stays available on every role, so a config written before roles existed keeps
 * type-checking and behaving identically (it lands on {@link StandaloneConfig}, the default).
 */

/**
 * The identity a {@link TenantVerifier} derives from a tenant's signed claim — the trust output the
 * `RunRequestResponder` uses to force `namespace`/ownership on a store-less pod's requests (spec §9).
 * Types only for this wave; the verification logic lands in a later wave.
 */
export interface VerifiedTenant {
  /** The tenant/partition the token authenticates as — the responder trusts THIS, never the body. */
  tenant: string;
  /** Capabilities the token grants, if the issuer scopes them. */
  capabilities?: string[] | undefined;
}

/**
 * Verifies a tenant's signed claim on the **responder** side (a `control-plane`), returning the
 * {@link VerifiedTenant} it authenticates as — or `null`/throwing to reject a tampered/invalid token.
 * A control-plane *verifies* tokens; it does not *carry* one (that is {@link TenantConfig.tenant}).
 * Typed here so the config compiles; the actual signature check is a later wave (spec §9).
 */
export type TenantVerifier = (input: {
  /** The signed token presented on the request (absent when a pod runs token-less on prefix isolation alone). */
  token?: string | undefined;
  /** The tenant the request *claims* to be — advisory only; the verifier derives the real one. */
  tenant?: string | undefined;
}) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/**
 * Single-process engine: a control-plane **plus an embedded worker** (spec §3). The default role, so
 * a config with no `role` lands here — reproducing today's single-process behavior byte-for-byte.
 * `store`/`transport` stay optional (omitting them selects the in-memory store/transport — the
 * zero-infra default), unlike the coordinator roles.
 */
export interface StandaloneConfig extends BaseDurableConfig {
  /** Optional here so a config with no `role` still type-checks and defaults to `'standalone'`. */
  role?: 'standalone';
  /**
   * Verifier for tenant tokens on incoming `RunRequest`/`StartRunMessage`s, as on a `control-plane`. A
   * standalone engine on a transport that carries the store-less protocol (`bullmq`, `queue`) also
   * answers tenant pods; without a verifier the wire `tenant` claim is trusted verbatim.
   */
  verifyTenant?: TenantVerifier;
}

/**
 * Pure coordinator (spec §3): owns the store, dispatches/recovers/times-out/responds, but runs **no**
 * embedded worker (bodies execute on separate `tenant` worker pods). It must own a store and a
 * transport, so both are required here.
 */
export interface ControlPlaneConfig extends BaseDurableConfig {
  role: 'control-plane';
  /** A coordinator owns durable state — required (a key of {@link BaseDurableConfig.stores}). */
  store: string;
  /** Required — the broker the coordinator dispatches over (a key of {@link BaseDurableConfig.transports}). */
  transport: string;
  /**
   * Responder-side verifier for tenant tokens on incoming `RunRequest`/`StartRunMessage` (spec §9).
   * The control-plane *verifies* a token and derives the tenant from it; it does not carry one. Typed
   * only for this wave — the verification logic is a later wave.
   */
  verifyTenant?: TenantVerifier;
}

/**
 * Store-less "thin" pod (spec §3): a worker (`durable:worker`) or an api/dashboard pod. It NEVER owns
 * a store — everything round-trips over the wire via the `ProxyRunGateway`. That isolation is a
 * **compile-time fact**: `store`/`stores` are `never`, so `defineConfig({ role: 'tenant', store })`
 * fails to type-check.
 */
export interface TenantConfig extends BaseDurableConfig {
  role: 'tenant';
  /**
   * FORBIDDEN — a store-less pod may not name a store. `never` makes any `store` value a compile
   * error, so tenant isolation is enforced by the type system, not a runtime `if (this.store)`.
   */
  store?: never;
  /** FORBIDDEN — likewise no store map on a store-less pod. */
  stores?: never;
  /** Required — the broker a tenant pod dispatches/consumes over. */
  transport: string;
  /** Required — which tenant this pod is; suffixes its `<name>@<tenant>` routing tokens (spec §6.1). */
  partition: string;
  /** The pod's signed claim, presented on every wire request (verified by the control-plane, spec §9). */
  tenant?: { token?: string };
  /** Extra advertised features beyond registered handler names (spec §7 capability negotiation). */
  capabilities?: string[];
  /** `ProxyRunGateway` request timeout (ms) for a proxied read/control round-trip (spec §8). */
  requestTimeoutMs?: number;
}

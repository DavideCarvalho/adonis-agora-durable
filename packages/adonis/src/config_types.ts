import type { BaseDurableConfig } from './define_config.js';

/**
 * Topology-discriminated config members for `config/durable.ts` (see
 * `docs/superpowers/specs/2026-07-17-store-less-cluster-design.md` §5). The engine's topology is
 * selected explicitly by `topology` — never inferred — and TypeScript narrows the accepted shape on the
 * `topology` literal so an invalid combination (a store-less `tenant` pod that names a store) is a
 * **compile error**, not a runtime assertion.
 *
 * These members are additive over {@link BaseDurableConfig} (today's field-for-field config): every
 * existing field stays available on every topology, so a config that omits `topology` keeps
 * type-checking and behaving identically (it lands on {@link StandaloneConfig}, the default).
 */

/**
 * The identity a {@link TenantVerifier} derives from a tenant's signed claim — the trust output the
 * `RunRequestResponder` uses to force `namespace`/ownership on a store-less pod's requests (spec §9).
 */
export interface VerifiedTenant {
  /** The tenant/partition the token authenticates as — the responder trusts THIS, never the body. */
  tenant: string;
  /** Capabilities the token grants, if the issuer scopes them. */
  capabilities?: string[] | undefined;
}

/** What a tenant verifier receives for each incoming request. */
export interface TenantVerifierInput {
  /** The token presented on the request (absent when a pod runs token-less on prefix isolation alone). */
  token?: string | undefined;
  /** The tenant the request *claims* to be — advisory only; the verifier derives the real one. */
  tenant?: string | undefined;
}

/**
 * Verifies a tenant's signed claim on the **responder** side (a `control-plane`), returning the
 * {@link VerifiedTenant} it authenticates as — or `null`/throwing to reject a tampered/invalid token.
 * A control-plane *verifies* tokens; it does not *carry* one (that is {@link TenantConfig.tenant}).
 * The function form of `verifyTenant` (what `hmacTenantVerifier` returns).
 */
export type TenantVerifier = (
  input: TenantVerifierInput,
) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/**
 * The class form of `verifyTenant`, for a verifier in its own file. Runs on the control plane for every
 * request a tenant process sends.
 */
export interface TenantVerifierContract {
  /**
   * Turn the wire token into the tenant it authenticates as. Return `null` (or throw) to reject:
   * the request is answered `unauthorized` and never touches a run. The returned `tenant` is trusted
   * as-is, so derive it from the verified token, never from `input.tenant`.
   */
  verify(input: TenantVerifierInput): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

/**
 * The class form of `tenant.token`, for a credentials source in its own file. Runs on the tenant
 * process before every wire request.
 */
export interface TenantCredentialsContract {
  /**
   * The token to present on the next request, sent as-is in the wire `tenant` field. Called once per
   * request, so cache the token here and refresh it before it expires. A throw (or an empty string)
   * fails that request with the error; the next request calls `token()` again.
   */
  token(): string | Promise<string>;
}

/** A class implementing a contract; constructor params are for `@inject()`. */
// biome-ignore lint/suspicious/noExplicitAny: a class with typed constructor params (`@inject()`) is not assignable to `unknown[]`.
export type ContractClass<T> = new (...args: any[]) => T;

/**
 * The `verifyTenant` option, in the same forms as a console `authorize`: an inline function (e.g.
 * `hmacTenantVerifier(secret)`), a class implementing {@link TenantVerifierContract} (built through the
 * container once, so `@inject()` works), a lazy import of a module whose default export is such a class
 * (`() => import('#tenants/verifier')`, imported once), or an object implementing the contract.
 */
export type TenantVerifierOption =
  | TenantVerifier
  | TenantVerifierContract
  | ContractClass<TenantVerifierContract>
  | (() => Promise<{ default: ContractClass<TenantVerifierContract> | TenantVerifierContract }>);

/**
 * The `tenant.token` option: a string, a function called before every request, a class implementing
 * {@link TenantCredentialsContract} (built through the container once), a lazy import of a module whose
 * default export is such a class, or an object implementing the contract.
 */
export type TenantTokenOption =
  | string
  | (() => string | Promise<string>)
  | TenantCredentialsContract
  | ContractClass<TenantCredentialsContract>
  | (() => Promise<{
      default: ContractClass<TenantCredentialsContract> | TenantCredentialsContract;
    }>);

/**
 * The resolved `tenant.token` the wire layer uses: a string, or a function called before each request
 * whose result travels as-is in the request's `tenant` field.
 */
export type TenantTokenSource = string | (() => string | Promise<string>);

/**
 * Single-process engine: a control-plane **plus an embedded worker** (spec §3). The default topology, so
 * a config with no `topology` lands here — reproducing today's single-process behavior byte-for-byte.
 * `store`/`transport` stay optional (omitting them selects the in-memory store/transport — the
 * zero-infra default), unlike the coordinator topologies.
 */
export interface StandaloneConfig extends BaseDurableConfig {
  /** Optional here so a config with no `topology` still type-checks and defaults to `'standalone'`. */
  topology?: 'standalone';
  /**
   * Verifier for tenant tokens on incoming `RunRequest`/`StartRunMessage`s, as on a `control-plane`. A
   * standalone engine on a transport that carries the store-less protocol (`bullmq`, `queue`, `db`) also
   * answers tenant pods; without a verifier the wire `tenant` claim is trusted verbatim.
   */
  verifyTenant?: TenantVerifierOption;
}

/**
 * Pure coordinator (spec §3): owns the store, dispatches/recovers/times-out/responds, but runs **no**
 * embedded worker (bodies execute on separate `tenant` worker pods). It must own a store and a
 * transport, so both are required here.
 */
export interface ControlPlaneConfig extends BaseDurableConfig {
  topology: 'control-plane';
  /** A coordinator owns durable state — required (a key of {@link BaseDurableConfig.stores}). */
  store: string;
  /** Required — the broker the coordinator dispatches over (a key of {@link BaseDurableConfig.transports}). */
  transport: string;
  /**
   * Responder-side verifier for tenant tokens on incoming `RunRequest`/`StartRunMessage` (spec §9).
   * The control-plane *verifies* a token and derives the tenant from it; it does not carry one. A
   * function, a class implementing {@link TenantVerifierContract}, or a lazy import of one.
   */
  verifyTenant?: TenantVerifierOption;
}

/**
 * Store-less "thin" pod (spec §3): a worker (`durable:worker`) or an api/dashboard pod. It NEVER owns
 * a store — everything round-trips over the wire via the `ProxyRunGateway`. That isolation is a
 * **compile-time fact**: `store`/`stores` are `never`, so `defineConfig({ topology: 'tenant', store })`
 * fails to type-check.
 */
export interface TenantConfig extends BaseDurableConfig {
  topology: 'tenant';
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
  /**
   * The pod's signed claim, presented on every wire request (verified by the control-plane, spec §9).
   * A string, a function called before each request (e.g. an OAuth access token that refreshes
   * itself), a class implementing {@link TenantCredentialsContract}, or a lazy import of one.
   */
  tenant?: { token?: TenantTokenOption | undefined };
  /** Extra advertised features beyond registered handler names (spec §7 capability negotiation). */
  capabilities?: string[];
  /** `ProxyRunGateway` request timeout (ms) for a proxied read/control round-trip (spec §8). */
  requestTimeoutMs?: number;
}

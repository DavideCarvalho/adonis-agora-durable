# `@adonis-agora/durable`

[![npm version](https://img.shields.io/npm/v/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable) [![npm downloads](https://img.shields.io/npm/dm/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable) [![CI](https://github.com/DavideCarvalho/adonis-agora-durable/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/DavideCarvalho/adonis-agora-durable/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable)

> Durable cross-app workflows for **AdonisJS** — deterministic replay engine.
> Part of the [Agora](https://github.com/DavideCarvalho) ecosystem.

## Packages

Everything ships in **one** package — install `@adonis-agora/durable` and reach each
feature through a subpath. The deterministic replay engine + AdonisJS binding is
the default entry; the integrations are optional subpaths whose peer dependencies
are installed only when used.

| Package | Status | What |
|---|---|---|
| [`@adonis-agora/durable`](./packages/adonis) [![npm](https://img.shields.io/npm/v/@adonis-agora/durable)](https://www.npmjs.com/package/@adonis-agora/durable) | ✅ shipped | the whole library — engine + AdonisJS binding (`.`), plus subpaths: `./otel`, `./telescope`, `./dashboard` (+ `./dashboard_provider`), `./commands` (ace commands), `./testing` (+ `./testing/conformance`), `./admission-redis` |
| [`@adonis-agora/durable-eslint-plugin`](./packages/eslint-plugin) [![npm](https://img.shields.io/npm/v/@adonis-agora/durable-eslint-plugin)](https://www.npmjs.com/package/@adonis-agora/durable-eslint-plugin) | ✅ shipped | ESLint rules enforcing workflow determinism (resolved by name; kept standalone) |

### Subpaths

| Import | What |
|---|---|
| `@adonis-agora/durable` | framework-agnostic engine (replay, steps, signals, sleeps, child workflows, sagas/compensation, leases, DLQ, continue-as-new, cron, cancellation, versioning), the config-driven transport (`memory` / `queue` / `db`) and state-store (`lucid`) drivers, and the AdonisJS binding (`defineConfig`, `WorkflowEngine` as a container singleton from `config/durable.ts`) |
| `@adonis-agora/durable/otel` | OpenTelemetry spans + lightweight metrics — one trace per run, one span per step (needs `@opentelemetry/api`) |
| `@adonis-agora/durable/telescope` | a `@adonis-agora/telescope` extension — a Workflows health dashboard (golden signals) |
| `@adonis-agora/durable/dashboard` | a self-contained web dashboard + JSON API for inspecting/operating runs (wire `@adonis-agora/durable/dashboard_provider`) |
| `@adonis-agora/durable/commands` | the ace commands — `durable:work`, `durable:runs`, `durable:retry` |
| `@adonis-agora/durable/testing` | test harness + asserts + fault injection + deterministic replay — no `vitest` required, importable from any test runner |
| `@adonis-agora/durable/testing/conformance` | cross-backend conformance suite generators for custom store/backend implementations (needs `vitest`) |
| `@adonis-agora/durable/admission-redis` | Redis-backed global admission backend for fleet-wide concurrency/rate/priority/fairness (needs `@adonisjs/redis` + `ioredis`) |

Defaults to an in-process store + transport (single-process). For cross-process /
production, select a driver by name in `config/durable.ts` — the `queue`
(`@adonisjs/queue`) or `db` (`@adonisjs/lucid`) transport and the `lucid` store —
each lazily importing its optional peer only when chosen. The engine is a faithful
port of `@dudousxd/nestjs-durable-core`.

Full docs live under [`docs/`](./docs) — if a run is stuck and you need to know which
knob heals it, start at [Failure modes & recovery](./docs/reliability/failure-modes.mdx).

## Sponsors

Every Agora library is MIT and stays free. The work is funded by partners and
sponsors — [become one](https://davidecarvalho.github.io/agora/partners).

## License

MIT © Davi Carvalho

---
"@adonis-agora/durable": patch
---

Tenant token capabilities accept wildcards, with the Agora-wide rule (new export `capabilityAllows(granted, required)`): a `*` segment matches one segment and a trailing `*` matches the rest. Stamping a run with a customer tenant is allowed by `tenancy:<id>`, `tenancy:*` or `*`. Tokens holding `*` (previously ignored for tenancy) can now stamp any tenant; a token with only `tenancy:<id>` still can't stamp another one (the run starts with no tenant, as before).

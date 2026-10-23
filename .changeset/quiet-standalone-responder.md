---
'@adonis-agora/durable': patch
---

A `standalone` engine on a broker transport (`bullmq`, `queue`, `db`) no longer logs `run-request responder started WITHOUT a tenant verifier` on every boot. Apps that never run tenant pods saw it as noise, and broker access already grants full trust there. An explicit `role: 'control-plane'` without `verifyTenant` still warns. `RunRequestResponder` gains a `warnWithoutVerifier` option (default `true`) for direct use.

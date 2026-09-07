---
'@adonis-agora/durable': patch
---

`drain()` now releases the recovery leases of runs still tracked in-flight on return, on both the settled and timeout paths. A shutting-down process hands off fast: the next boot's recovery reclaims the frontier work in seconds instead of waiting out the lease expiry.

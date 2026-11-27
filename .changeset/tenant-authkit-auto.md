---
'@adonis-agora/durable': minor
---

`topology: 'tenant'` needs no `tenant` block when `@adonis-agora/authkit-client` is booted with its `service` configured: its `authkit.client.tenantOf('urn:agora:durable')` supplies the pod's `partition` and `token`. Detected by shape (no dependency on authkit-client; a version without `tenantOf` counts as absent). Each field set in `tenant` wins, one by one, and `tenant: { auto: false }` turns it off. With neither, a web boot (and `durable:work`) fails naming both fixes. `agora:doctor`'s `durable.tenant-token` shows where each field came from (`authkit-client (auto)` or `explicit`).

---
'@adonis-agora/durable': patch
'@adonis-agora/durable-eslint-plugin': patch
'@adonis-agora/durable-dashboard': patch
---

Declare `engines.node` as a supported RANGE again, and stop Renovate from re-pinning it.

All three packages shipped an exact runtime string (`"node": "v22.23.2"` / `"node": "v26.7.0"`) instead of a range. `engines.node` states which runtimes a package supports, so an exact value warns on every consumer install on any other Node and fails hard under `engine-strict`. The values were rewritten by Renovate's global `rangeStrategy: "pin"`, so `renovate.json` now disables updates for the `engines` dep type — otherwise the fix is undone on the next cycle.

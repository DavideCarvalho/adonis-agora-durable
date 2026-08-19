---
'@adonis-agora/durable': patch
---

Remove the `<23` upper bound from `engines.node`.

`0.24.0` shipped `">=20.6.0 <23"` while every other package in the ecosystem declares `">=20.6.0"`. `engines.node` states which runtimes a package supports, so the ceiling asserted that durable does not run on Node 23 or newer — which is false. The practical effect was to exclude consumers already on Node 24: an install that only warns normally becomes a hard failure under `engine-strict`.

There is no technical basis for the bound. It arrived in a commit titled "align Node to CI", which set it to the Node that CI happens to run rather than to a runtime constraint, and it was never applied to the sibling packages. The library uses no Node API that changed in 23+ (only long-stable builtins, with no version gates anywhere), the full test suite passes on Node 26, and an end-to-end run — durable execution, replay from checkpoints, saga compensation, `AsyncLocalStorage`-backed context, lifecycle events — behaves identically on Node 22 and Node 26.

A new `engines.spec.ts` now pins the range across all three published packages and fails on either shape this field has gone wrong in before: an upper bound, or an exact pinned version.

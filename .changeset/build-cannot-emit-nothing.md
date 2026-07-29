---
'@adonis-agora/durable': patch
'@adonis-agora/durable-eslint-plugin': patch
---

Build: `pnpm build` can no longer exit 0 having emitted no JavaScript. `tsc` ran with `incremental: true` against a `.tsbuildinfo` that records what it already wrote to `dist/`, so removing `dist/` and leaving the buildinfo behind (a plain `rm -rf dist`, then a build) made the compiler conclude every output was current and emit nothing. The `copy:stubs` half is a plain `cp`, so it still ran: the result was a `dist/` holding `assets/` and `stubs/` and zero `.js` files, from a build that reported success. Turbo then wrote that empty directory into its cache as a successful `build` and replayed it — `>>> FULL TURBO` — on every later run, including from an otherwise clean tree, so one such build poisoned the cache for good.

The build now removes `dist/` before compiling and compiles through a `tsconfig.build.json` with `incremental: false`, so it keeps no state that can disagree with `dist/`, and a new post-condition fails the build outright if `dist/` ends up without JavaScript or without the package entrypoint. That check runs inside the `build` script rather than in CI, which is what makes it cover `prepack` — the path a manual `pnpm publish` takes, and the one place turbo was never involved. `build` and `typecheck` also stop sharing a single buildinfo file, so the two turbo tasks can no longer race on it or restore each other's incremental state from cache.

No published version is known to be affected. CI builds from a cold checkout, so the trigger (removing `dist/` from a tree that already had a buildinfo) does not arise there, and `@adonis-agora/durable`'s spec that imports the built `dist/src/index.js` hard-fails under CI when the build is missing — both release workflows run the suite before publishing. The exposure was a developer machine and any cache shared from one. There is nothing to re-install or re-publish because of this.

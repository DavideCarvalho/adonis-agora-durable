---
'@adonis-agora/durable': minor
---

Workflow and step discovery can scan several directories, for modular apps that keep one folder per bounded context. `workflowsPath` and `stepsPath` in `config/durable.ts` now accept `string | string[] | false`, and an empty array is the same as `false`. The provider's runtime scan and `node ace durable:worker` walk every directory.

The `workflowsHook` / `stepsHook` codegen hooks take `source: string | string[]`. With several directories each hook still writes a single barrel at the same output path. The barrel is an array with one entry per root, each module imported through a relative path, and the file watcher regenerates it on a change in any root. A single directory produces the same barrel as before, byte for byte.

When two directories define the same workflow name and version, or the same step name, with different classes or handlers, boot now fails with a `DuplicateDiscoveryError` that names both files, and nothing is registered. Duplicates inside one directory behave as before.

`WorkflowEngine.handle(name, fn)` serves a step on the engine's transport, so app code can register an extra directory from a preload with `registerStepsFromDir(engine, dir)`. `registerWorkflowsFromDir` and `registerStepsFromDir` accept an array of directories too.

Also fixed: a single-directory barrel with a sub-directory (`app/workflows/billing/refund_workflow.ts`) crashed the provider at boot, because the generator nests those entries and the loader called the nested object as a function. Nested entries now register.

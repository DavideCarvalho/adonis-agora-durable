---
"@adonis-agora/durable": patch
---

A run no longer executes twice at once in one process. The run lease is per engine instance, so a resume landing while this same process was still executing the run (a signal delivered while the run was parking, a late step result, a second signal, an explicit `resume()`) went straight past it and ran the body concurrently: a step whose checkpoint was not written yet ran twice. Resumes of a run are now serialized in-process: one landing mid-execution is queued and re-drives the run once that execution has settled and released its lease (resumes queued meanwhile coalesce into it), so the wake is neither doubled nor lost. Across processes the lease still decides, unchanged.

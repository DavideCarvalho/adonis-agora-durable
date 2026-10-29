---
'@adonis-agora/durable': patch
---

perf(engine): a run whose workflow is registered here no longer pays an `await` for the unregistered-workflow check added in 0.57.0. Recovery (`recoverIncomplete`) and the run-queue hand-off (`handOffDue`) check the local registry synchronously first, and only fall back to the async convention-routing lookup when the workflow is not registered locally.

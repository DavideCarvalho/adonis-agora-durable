---
'@adonis-agora/durable': patch
---

fix(engine): a pod killed mid-flight no longer strands its runs.

- A step result is now acknowledged only after its run is durably marked as owed a turn (its
  `suspended` timer is pulled in to one lease from now). Before, a pod that settled a result and died
  before — or during — the background resume left the run `suspended` until the 5-minute reconcile
  wake; now any instance's due-timer poll resumes it once the dead pod's lease lapses.
- A turn that died between writing a step's `pending` checkpoint and handing the job to the broker
  no longer leaves that step undispatched forever. Recovery (an orphaned `running` run, or a
  `suspended` run whose lease holder died holding it) re-sends the steps that turn wrote, under the
  run's lease, with their original `stepId` — a step whose first dispatch did land may run twice,
  within the documented at-least-once contract.

---
"@adonis-agora/durable": major
---

A compensating cancel no longer writes or reads a buffered `cancel:<runId>` marker. The persisted `cancelling` status is the durable intent: a turn picks it up at start, and a turn already running on another pod when the cancel lands finds it at its settle (the status check no longer matches) and runs the saga undo there, on every exit (return, throw, continue-as-new, suspend). Every turn exit saves a buffered-signal read and re-write.

Upgrade note: stop pre-1.0 engines before or while deploying 1.0. They rely on the marker 1.0 no longer writes, so while one of them still executes a run, a compensating cancel issued from a 1.0 pod can wait for crash recovery before its undo runs.

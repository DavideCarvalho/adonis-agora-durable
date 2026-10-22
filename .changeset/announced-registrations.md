---
"@adonis-agora/durable": minor
---

Workers announce the workflows they run (handshake §7.9): `WorkerDescriptor.registrations` (name, version, group, requires, origin, onError), with `aggregateAnnouncements` to fold a fleet's statements. `WorkerRuntime.registerWorkflow(name, body, meta)` announces them, and `workflowAnnouncement(Class)` builds `meta` from a class. A workflow the engine serves by convention is now routed by the onError routes its live workers announce; workers that disagree route nothing and emit `run.unrouted`. The canonical descriptor hash adds `registrations` only when present, so existing hashes are unchanged; the golden fixtures `descriptor-registrations.json` and `descriptor-on-error.json` pin the cross-SDK hashes.

---
"@adonis-agora/durable": minor
"@adonis-agora/durable-dashboard": minor
---

Federated console: one app's durable console can show the runs of other apps that keep their own store and engine. List them under `apps` in `config/durable_dashboard.ts` (each with that app's `store` and `controlPlane`); the console gets an app selector (`?app=<key>` in the URL), reads the picked app's runs from its store, and sends every action on them (cancel, retry, signal, resume, fix-and-replay, schedule pause/trigger, worker health) to that app's engine over its control plane, where exactly one instance runs it. The owning app opts in with `consoleCommands: true` in its `config/durable.ts`. `controlPlanes.redis` carries the new console commands; an `authorize` that grants `apps` as a list also hides the federated apps it does not name.

---
'@adonis-agora/durable': patch
'@adonis-agora/durable-dashboard': patch
---

Federated console: the App selector says which apps are federated, and who runs actions on them. `GET /apps` now gives each `apps[]` entry `mode: 'federated'` and `actions` (`'app'`: actions are sent to that app, which runs them; `'none'`: a built control plane that cannot carry console commands, so the console only browses that app). The selector tags federated apps (and the trigger, when one is picked), every page shows a notice while a federated app is picked, and with `actions: 'none'` the run, wait, bulk and schedule actions are disabled with the reason. Older servers omit both fields and the console behaves as before.

---
"@adonis-agora/durable": minor
---

Timestamps: ships the console's new run Created/Updated fields, and the state-store conformance suite now asserts that `createdAt` never moves (runs: through `updateRun` / `updateRunIf`; schedules: through `updateSchedule`) while `updatedAt` follows each write to the millisecond. The bundled stores already pass; no schema change.

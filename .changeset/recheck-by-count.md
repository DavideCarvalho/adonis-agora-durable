---
"@adonis-agora/durable": patch
---

The check a turn makes after suspending on a step, whether that step already settled, is a `COUNT`
where the store has `countCheckpoints`. It read the step's whole row, so every turn of a
conversation read back the input of the LLM step it had just sent.

---
"@adonis-agora/durable": minor
---

`node ace agora:doctor`: one health check for every installed `@adonis-agora` lib, with `--json`, `--lib`, `--deep`, `--only`, `--strict`, `--verbose` and `--no-boot`; exit `0` (no error), `1` (an error, or a warning with `--strict`) or `2` (the doctor could not run). `node ace durable:doctor` runs durable's checks only: `durable.config`, `durable.verify-tenant`, `durable.tenant-token`, `durable.cron-parser`, `durable.store-tables` (`--deep`), `durable.console-gate`, plus `durable.peers` and `durable.agora-siblings`. New `@adonis-agora/durable/doctor` entry with the checks, read by `--no-boot`.

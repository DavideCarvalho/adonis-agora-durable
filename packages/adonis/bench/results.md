# Dispatched-step bench results

Port of the nestjs-durable performance chain (sticky continuations, round-trip-saving store methods,
constant-SQL hot path, batched pending-run claims, routed step results, descriptor reads). Same
machine (shared, noisy), Postgres 17 + Redis 7 in containers, `master` (adbe550) against this branch,
each built (`tsc -p tsconfig.build.json`) and run with the same script (`BENCH_ROOT` for master).

## `dispatched-steps.mjs`: 1,000 five-step workflows, 4 step-worker processes

Every step is a dispatched `ctx.step`. SQL counts the engines' statements only; CPU is the engines'
total per workflow.

| Engines | Build | wf/s | SQL / step | Engine CPU / workflow | Sticky hits |
| --- | --- | --- | --- | --- | --- |
| 1 | master | 94.6 – 103.5 | 15.2 | 8.6 – 8.8 ms | — |
| 1 | branch | 111.1 – 118.5 | 10.2 | 6.2 – 6.5 ms | 100% |
| 4 | master | 72.3 – 77.3 | 22.1 – 22.5 | 23.4 – 24.1 ms | — |
| 4 | branch | 127.1 – 132.3 | 10.3 | 11.6 – 12.6 ms | 100% |

## `dispatched-steps.mjs long`: one workflow of 1,000 sequential steps

| Engines | Build | Total | ms / step (first quarter → last quarter) | SQL / step |
| --- | --- | --- | --- | --- |
| 1 | master | 14.5 s | 13.6 → 14.6 | 13.0 |
| 1 | branch | 9.2 s | 9.6 → 8.9 | 8.0 |
| 4 | master | 17.5 s | 16.5 → 16.1 | 17.5 |
| 4 | branch | 11.1 s | 12.8 → 10.3 | 11.0 |

Agora's replay already read the history without inputs and from one snapshot per turn, so on master
the per-step cost was already flat over the run; the branch takes the replay out of the step entirely.

## Per commit

| Commit | Measured against | Result |
| --- | --- | --- |
| sticky continuations + round-trip methods | master | 15.2 → 10.2 SQL/step (1 engine), 100% hits |
| constant-SQL hot path (Postgres) | previous commit | engine CPU 8.2 → 6.5 ms/workflow (Knex + Lucid + lodash were ~21% of it) |
| batched pending-run claims (`claim-pending.mjs`, no broker, 1,000 five-localStep workflows) | previous commit | 1 process 195–235 → 243–278 wf/s, 4 processes 338–404 → 409–492 wf/s; 28–30.7 → 25.9 SQL/workflow |
| routed step results (BullMQ) | master | 4 engines: 21–22 → 10.4 SQL/step, 100% hits |

The ranges are two rounds each; the box runs other projects' containers, so wall-clock numbers move by
10–20% between rounds. SQL per step is stable to the second decimal.

---
"@adonis-agora/durable": minor
---

Require cron-parser 5

The optional `cron-parser` peer narrows from `^4.0.0 || ^5.0.0` to `^5.0.0`, and the
scheduler no longer recognises v4's `parseExpression` entry point — an unsupported major
now fails at load with a message naming the version it wants, rather than resolving to a
parser this code no longer drives correctly.

Only projects that schedule workflows by cron are affected, and only those still on
cron-parser 4: install cron-parser 5. Nothing about cron expressions, timezones or fire
times changes; the scheduler computed identical fires under both majors, which is what
the compatibility suite asserted before this.

---
'@adonis-agora/durable': patch
---

The adaptive concurrency controller (BullMQ and queue transports) takes its no-queuing baseline from the
window's median latency, smoothed to follow a drop at once and a rise slowly, instead of from the
window's fastest step. With workers sharing one Redis and one database, a step that landed on a quiet
moment set the baseline ten times below a steady p50, and held workers at one or two slots. A tick with
no settled step no longer moves the limit, so an idle worker no longer cuts itself down between bursts.
Same change as the aviary controller: a 40,000-step fan after a warm-up fan went from 61–67 s to 26 s
in a six-process bench, level with a fixed concurrency of 32, and tied it when the steps saturated the
database.

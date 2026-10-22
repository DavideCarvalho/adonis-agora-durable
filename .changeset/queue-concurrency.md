---
'@adonis-agora/durable': minor
---

The `queue` transport can run several jobs of one step at once, and idle workers stop hammering the backend.

- `transports.queue({ concurrency })`: each step name's task loop awaited one job before popping the next, so a worker ran one job of a step at a time however deep the backlog. With `concurrency: N` the loop keeps up to N jobs in flight. The slots share the single poll loop, so they add no polling, and every in-flight claim is renewed and drained on `close()`. The default stays 1.
- `transports.queue({ resultConcurrency })`: the engine settles up to N results at once (default 1), as on `bullmq`.
- `transports.queue({ idleBackoffMax })`: every loop polled at `pollIntervalMs` forever, so an idle worker serving 30 step names hit the backend about 150 times a second. Idle task, heartbeat and control loops now double their sleep after each empty poll, up to `idleBackoffMax × pollIntervalMs` (default 4, so 800ms), and the first job found resets them. That costs up to 800ms of pickup latency on the first job after a quiet spell; `1` restores the fixed cadence. The results loop never backs off.

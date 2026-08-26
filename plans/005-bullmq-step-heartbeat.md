# Plan 005: Emit step heartbeats from the BullMQ transport

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b4ba291..HEAD -- packages/adonis/src/transports/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: `plans/001-restore-local-verification-baseline.md`
- **Category**: bug
- **Planned at**: commit `b4ba291`, 2026-07-29

## Why this matters

`runStepHandler` takes an optional third argument: a callback the transport uses
to publish step liveness beats. The `db` and `queue` transports both pass it.
BullMQ does not — even though `BullMQTransport.heartbeat()` is fully implemented
and `onHeartbeat` already subscribes. The lane is wired at both ends and nothing
ever publishes on it from the step execution path.

The consequence is not cosmetic. `engine.awaitWithHeartbeat` rearms its liveness
window only when a beat arrives. On BullMQ a healthy, actively-progressing long
step emits none, so at `timeoutMs` the engine concludes the worker is dead and
re-dispatches **the same `stepId`** while the original worker is still executing
it — duplicate concurrent execution of a step, repeated up to `retries`. A step
with a `timeoutMs` that behaves correctly on `db` or `queue` breaks when the app
migrates to BullMQ, which is the transport you would pick for scale.

The class doc advertises the feature that does not work.

## Current state

- The bug — `packages/adonis/src/transports/bullmq/bullmq-transport.ts:304-312`.
  Two arguments where the siblings pass three:

  ```ts
  async #runTask(task: RemoteTask): Promise<void> {
    let result: StepResult;
    try {
      result = await runStepHandler(task, this.#handlers.get(task.name));
    } catch (err) {
      // runStepHandler is pure (a handler throw becomes a failed StepResult), so reaching here is a
      // bug — guard anyway so a future refactor can't turn it into an unsettled `pending` checkpoint.
      this.#onError(err);
  ```

- The correct shape, `packages/adonis/src/transports/db.ts:310-312`:

  ```ts
  const result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
    this.heartbeat(beat),
  );
  ```

- And `packages/adonis/src/transports/queue.ts:332-334`:

  ```ts
  const result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
    this.heartbeat(beat),
  );
  ```

- The receiving end already exists on BullMQ:
  `bullmq-transport.ts:337-343` implements `heartbeat()`, and `:400-412`
  implements `onHeartbeat` subscription. The class doc at
  `bullmq-transport.ts:74` advertises that "long-step heartbeats ride a
  `${P}-heartbeat` pub/sub".

- The transport conformance harness lives at
  `packages/adonis/src/testing-kit/transport-conformance.ts` and is applied to
  the other transports by specs under
  `packages/adonis/test/engine/transports/`. Note that BullMQ is currently the
  **only** transport with no conformance spec — its existing test
  (`test/engine/transports/bullmq/bullmq-transport.spec.ts:22`) uses an
  in-memory fake broker and states it "proves naming + job shape + the heartbeat
  registry with no Redis". That fake could not have caught this, because it
  never runs a beating handler end to end.

- Repo conventions: conventional commits; vitest; changesets.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Targeted | `pnpm --filter @adonis-agora/durable test -- bullmq` | bullmq specs pass |
| Lint | `pnpm lint` | exit 0 |
| Changeset | `pnpm changeset` | creates a file in `.changeset/` |

## Scope

**In scope** (the only files you should modify):
- `packages/adonis/src/transports/bullmq/bullmq-transport.ts` (the one call)
- `packages/adonis/test/engine/transports/bullmq/bullmq-transport.spec.ts` (add a case)
- `.changeset/<generated>.md` (create)

**Out of scope** (do NOT touch, even though they look related):
- `packages/adonis/src/transports/db.ts` and `queue.ts` — already correct.
- `packages/adonis/src/engine.ts` — `awaitWithHeartbeat` is correct; it is not
  receiving beats because none are sent.
- `packages/adonis/src/transports/bullmq/deps.spec.ts` — it has an unrelated
  pre-existing failure (documented in plan 001). Do not try to fix it here.
- Adding a full BullMQ conformance spec. It is the right follow-up but it needs
  a real Redis in CI, which this repo does not yet have — see Maintenance notes.

## Git workflow

- Branch: `fix/bullmq-step-heartbeat`
- One commit; message style: conventional commits, e.g.
  `fix(bullmq): emit step heartbeats so long steps aren't presumed dead`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pass the heartbeat callback

In `packages/adonis/src/transports/bullmq/bullmq-transport.ts:308`, change:

```ts
result = await runStepHandler(task, this.#handlers.get(task.name));
```

to match the sibling transports:

```ts
result = await runStepHandler(task, this.#handlers.get(task.name), (beat) =>
  this.heartbeat(beat),
);
```

Confirm `this.heartbeat` is in scope at that point and has the same signature
the other two transports call (read `bullmq-transport.ts:337-343`).

**Verify**: `pnpm typecheck` → exit 0

### Step 2: Add a test that a beating handler produces a delivered beat

Extend `packages/adonis/test/engine/transports/bullmq/bullmq-transport.spec.ts`
with a case that:

1. Constructs the transport against the file's existing in-memory fake broker.
2. Registers a step handler that calls its heartbeat/progress callback at least
   once before resolving.
3. Subscribes via `onHeartbeat`.
4. Runs the task and asserts at least one heartbeat was delivered, carrying the
   expected `stepId`.

Read the existing spec first and reuse its fake-broker setup rather than
inventing a new harness. If the fake broker does not route the heartbeat
pub/sub channel at all, extend it minimally so it does — that gap is part of why
this bug survived.

**Verify**: `pnpm --filter @adonis-agora/durable test -- bullmq` → the new case
passes.

### Step 3: Prove the test detects the bug

Revert Step 1 (drop the third argument), re-run the spec, and confirm the new
case **fails**. Then restore the fix.

This is mandatory. The existing BullMQ spec passed for the entire life of this
bug; a new test that does the same is worse than none.

**Verify**: without the callback the new case fails; with it restored,
`pnpm --filter @adonis-agora/durable test -- bullmq` → exit 0.

### Step 4: Add a changeset

```bash
pnpm changeset
```

Select `@adonis-agora/durable`, choose a **patch** bump. Describe the
user-facing effect: on the BullMQ transport, steps with a `timeoutMs` no longer
false-timeout and get re-dispatched while still running, because the transport
now emits the step heartbeats the engine's liveness window depends on.

**Verify**: `ls .changeset/*.md` → your new file is present.

## Test plan

- Modified file:
  `packages/adonis/test/engine/transports/bullmq/bullmq-transport.spec.ts`.
  - New case: a handler that beats produces at least one `onHeartbeat` delivery
    with the correct `stepId`.
- Structural pattern: the file's own existing fake-broker cases.
- Mutation check (Step 3) is required.
- Verification: `pnpm test` → all pass except the pre-existing, out-of-scope
  `deps.spec.ts` failure documented in plan 001.

## Done criteria

ALL must hold:

- [ ] `grep -n "runStepHandler" packages/adonis/src/transports/bullmq/bullmq-transport.ts` shows a three-argument call
- [ ] All three transports (`db.ts`, `queue.ts`, `bullmq-transport.ts`) pass a heartbeat callback — verify with `grep -rn "runStepHandler" packages/adonis/src/transports/`
- [ ] The new test case exists and passes
- [ ] The mutation check in Step 3 was performed and the case failed without the fix
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 (or only the known `deps.spec.ts` failure remains)
- [ ] A changeset file exists in `.changeset/`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The call at `bullmq-transport.ts:308` already passes three arguments.
- `this.heartbeat` is not reachable from `#runTask`, or its signature differs
  from what `db.ts` / `queue.ts` pass. That would mean the fix is not the
  one-line change this plan assumes.
- The fake broker cannot be made to route the heartbeat channel without a
  redesign of the test harness — report rather than rewriting the harness.
- Adding the callback causes existing BullMQ specs to fail. That would indicate
  the beat has a side effect the fake broker does not model, which needs
  investigation rather than a workaround.

## Maintenance notes

- **The real gap this exposes**: BullMQ is the only transport without a
  conformance spec. `assertTransportConformance` is applied to
  `EventEmitterTransport`, `QueueTransport`, `DbTransport` and
  `InMemoryTransport`, but BullMQ is verified only against a fake broker it
  cannot disagree with. Adding `bullmq-conformance.spec.ts` behind the existing
  `skipIf(!REDIS_URL)` gate — plus a `redis:7` service in
  `.github/workflows/ci.yml` so the gated suites actually run — is the follow-up
  that prevents the next bug of this shape. Deliberately out of scope here.
- Seven Redis-dependent spec files currently self-skip in CI because
  `REDIS_URL` is never set; the two most deployment-critical components
  (`RedisAdmissionBackend` and `BullMQTransport`) are therefore the least
  verified. Worth raising separately.
- A reviewer should check the three-argument call is identical in shape across
  all three transports, so a future reader sees one pattern rather than two.

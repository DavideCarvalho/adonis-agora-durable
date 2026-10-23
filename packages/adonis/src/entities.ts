import { FatalError } from './errors.js';
import type { WorkflowCtx } from './interfaces.js';
import { PACKAGE_ORIGIN } from './package-origin.js';

/** One operation on a durable entity: mutate `state` in place and/or return a result. */
export type EntityHandler<S = unknown> = (state: S, arg: unknown) => unknown | Promise<unknown>;

/** A durable keyed entity (a virtual object): per-key serialized handlers over durable state. */
export interface EntityConfig<S = unknown> {
  /** Build the initial state for a fresh key. */
  initialState: () => S;
  /** Operation handlers, keyed by op name. Each runs serially per key, exactly once. */
  handlers: Record<string, EntityHandler<S>>;
}

/** The slice of the engine the entity subsystem needs (so it stays a standalone module). */
export interface EntityHost {
  register(
    name: string,
    version: string,
    fn: (ctx: WorkflowCtx, input: unknown) => Promise<unknown>,
    opts?: { origin?: string | undefined },
  ): void;
  signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
  ): Promise<{ runId: string }>;
  getEvent<T>(runId: string, key: string): Promise<T | undefined>;
  signal(token: string, payload: unknown): Promise<unknown>;
}

/**
 * What a workflow-side send needs on top of {@link EntityHost}: a durable buffer write it can AWAIT
 * inside its turn, and a way to wake an entity run that is parked on its wait. Optional so a bare
 * {@link EntityHost} (tests, older hosts) still works through {@link Entities.dispatch}.
 */
export interface EntityWorkflowHost {
  /** Durably buffer `payload` on `token` (the store's `bufferSignal`). */
  bufferSignal(token: string, payload: unknown): Promise<void>;
  /** If a run is parked on `token`, wake it with `payload`; if none is, do nothing (no buffering). */
  wakeWaiter(token: string, payload: unknown): Promise<unknown>;
  /** Start `runId` of `workflow` if it doesn't exist yet (idempotent by run id). */
  ensureStarted(workflow: string, input: unknown, runId: string): Promise<unknown>;
}

/** The message an entity run consumes from its token. */
interface EntityMessage {
  op?: string;
  arg?: unknown;
  /** Signal token that receives the handler's result (`ctx.callEntity`). */
  reply?: string;
  /** Stable id of a workflow-side send (`<runId>:<seq>`): a re-sent copy of the same op is skipped. */
  id?: string;
  /** A wake-up with no operation (see {@link Entities.kick}); the runner just waits again. */
  nudge?: true;
}

const NUDGE: EntityMessage = { nudge: true };

const ENTITY_WORKFLOW = '__entity';
const entityRunId = (name: string, key: string): string => `entity:${name}:${key}`;

/**
 * Durable keyed **entities** (virtual objects): a keyed actor whose handlers run **serialized per
 * key** over **durable state**, exactly once. Each key is one long-lived run (`entity:<name>:<key>`)
 * processing ops in order. Drive it with `signal` (fire) or `ctx.callEntity` (call + await result),
 * read state with `getState`. Registers its built-in runner on construction.
 */
export class Entities {
  private readonly configs = new Map<string, EntityConfig>();

  constructor(
    private readonly host: EntityHost,
    private readonly workflowHost?: EntityWorkflowHost,
  ) {
    host.register(ENTITY_WORKFLOW, '1', (ctx, input) => this.run(ctx, input), {
      origin: PACKAGE_ORIGIN,
    });
  }

  register<S>(name: string, config: EntityConfig<S>): void {
    this.configs.set(name, config as EntityConfig);
  }

  /** Deliver an op to an entity's runner, starting it on first contact. `reply` (a signal token)
   *  receives the handler's result, for `ctx.callEntity`. */
  dispatch(
    name: string,
    key: string,
    op: string,
    arg: unknown,
    reply?: string,
  ): Promise<{ runId: string }> {
    const runId = entityRunId(name, key);
    return this.host.signalWithStart(ENTITY_WORKFLOW, { name, key }, runId, {
      token: runId,
      payload: { op, arg, reply },
    });
  }

  /**
   * The durable half of a send from INSIDE a workflow (`ctx.callEntity` / `ctx.signalEntity`): write
   * the op to the entity's signal buffer and return once it is stored, so the caller can checkpoint
   * after it. The op carries `id`, the caller's stable `<runId>:<seq>`, so if the caller dies between
   * this write and its checkpoint and sends again on replay, the entity skips the second copy. The
   * wake-up ({@link kick}) is separate and may be lost: the buffered op is still consumed by the
   * entity's next wait. Falls back to a plain {@link dispatch} on a host without a workflow host.
   */
  async enqueue(
    name: string,
    key: string,
    op: string,
    arg: unknown,
    id: string,
    reply?: string,
  ): Promise<boolean> {
    if (!this.workflowHost) return false;
    const message: EntityMessage = { op, arg, id, ...(reply ? { reply } : {}) };
    await this.workflowHost.bufferSignal(entityRunId(name, key), message);
    return true;
  }

  /**
   * Make the entity act on what {@link enqueue} buffered: start its run if it has none, and wake it
   * if it is parked on its wait. A run that is busy needs nothing: its next wait reads the buffer
   * before suspending. The wake carries a no-op `nudge`, never the op itself, so the op stays in
   * the buffer in arrival order and a lost or repeated kick costs at most one empty iteration.
   */
  async kick(name: string, key: string): Promise<void> {
    const host = this.workflowHost;
    if (!host) return;
    const runId = entityRunId(name, key);
    await host.ensureStarted(ENTITY_WORKFLOW, { name, key }, runId);
    await host.wakeWaiter(runId, NUDGE);
  }

  /**
   * {@link kick} by the entity's run id (`entity:<name>:<key>`), for the lost-wake reconcile. Returns
   * false for a run id that is not an entity's, or an entity this process does not know.
   */
  async kickRunId(runId: string): Promise<boolean> {
    if (!runId.startsWith('entity:')) return false;
    const rest = runId.slice('entity:'.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return false;
    const name = rest.slice(0, sep);
    if (!this.configs.has(name)) return false;
    await this.kick(name, rest.slice(sep + 1));
    return true;
  }

  async signal(name: string, key: string, op: string, arg?: unknown): Promise<void> {
    await this.dispatch(name, key, op, arg);
  }

  getState<S = unknown>(name: string, key: string): Promise<S | undefined> {
    return this.host.getEvent<S>(entityRunId(name, key), 'state');
  }

  /** The built-in runner: one long-lived run per key, processing ops serially over state. */
  private async run(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { name, key } = input as { name: string; key: string };
    const config = this.configs.get(name);
    if (!config) throw new FatalError(`entity "${name}" is not registered`);
    const token = entityRunId(name, key);
    let state = config.initialState();
    // Ids of workflow-side sends already handled. Rebuilt on replay from the recorded messages, so
    // the skip below is deterministic.
    const seen = new Set<string>();
    for (let i = 0; ; i += 1) {
      const msg = (await ctx.waitForSignal(token)) as EntityMessage;
      if (msg.nudge) continue; // a wake-up only: the op it announced is read from the buffer next
      if (msg.id !== undefined) {
        if (seen.has(msg.id)) continue; // a re-sent copy of an op already applied: exactly once
        seen.add(msg.id);
      }
      const op = msg.op as string;
      // Run the handler and snapshot the (possibly mutated) state in ONE checkpoint, so replay
      // restores the state from the checkpoint instead of re-running the handler.
      const out = await ctx.localStep(`op:${i}`, async () => {
        const handler = config.handlers[op];
        if (!handler) throw new FatalError(`entity "${name}" has no handler for op "${op}"`);
        const result = await handler(state, msg.arg);
        return { result, state };
      });
      state = out.state; // carry state forward (and restore it from the checkpoint on replay)
      await ctx.setEvent('state', state); // publish for getState
      if (msg.reply) {
        const reply = msg.reply;
        await ctx.localStep(`reply:${i}`, async () => {
          await this.host.signal(reply, out.result);
        });
      }
    }
  }
}

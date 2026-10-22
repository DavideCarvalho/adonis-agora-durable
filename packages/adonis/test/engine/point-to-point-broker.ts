import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../../src/interfaces.js';
import { runStepHandler, type StepHandler } from '../../src/protocol.js';

/** Replays one workflow turn into its decision — the Python `@workflow` worker stand-in. Returning
 *  `null` models a worker that died mid-turn: no decision is ever published for that task. */
export type TurnWorker = (
  task: WorkflowTask,
) => WorkflowDecision | null | Promise<WorkflowDecision | null>;

interface Consumer<T> {
  pod: string;
  fn: (message: T) => Promise<void>;
}

/**
 * ONE broker shared by several engine replicas ("pods"), each talking to it through its own
 * {@link pod} transport — the way two processes each hold a BullMQ / queue client on the same Redis.
 *
 * The defining property: step results and workflow-turn DECISIONS are POINT-TO-POINT. Each message
 * goes to exactly one subscribed consumer, and a decision goes to a pod OTHER than the one that
 * dispatched the turn whenever one is subscribed (the `${P}-decisions` queue hands it to whichever
 * replica polls first). A replica that keeps the turn's waiter in memory never sees that decision.
 */
export class PointToPointBroker {
  readonly steps = new Map<string, StepHandler>();
  worker?: TurnWorker;
  /** Every dispatched workflow turn, with the pod that dispatched it. */
  readonly turns: { pod: string; task: WorkflowTask }[] = [];
  /** Deliver a decision INSIDE `dispatchWorkflowTask`, before it returns (the fastest possible
   *  worker): a dispatcher that records the awaited turn only after enqueueing would miss it. */
  sync = false;
  private readonly results: Consumer<StepResult>[] = [];
  private readonly decisions: Consumer<WorkflowDecision>[] = [];
  private readonly beats: Consumer<Heartbeat>[] = [];
  private resultCursor = 0;

  pod(name: string): Transport {
    const subscribe = <T>(list: Consumer<T>[], fn: (message: T) => Promise<void>) => {
      // A handler set per client, as bullmq / queue / db keep: the same function registers once.
      if (!list.some((c) => c.pod === name && c.fn === fn)) list.push({ pod: name, fn });
    };
    return {
      dispatch: async (task: RemoteTask) => this.dispatchStep(task),
      onResult: (fn) => subscribe(this.results, fn),
      onHeartbeat: (fn) => subscribe(this.beats, fn),
      dispatchWorkflowTask: async (task: WorkflowTask) => this.dispatchTurn(name, task),
      onDecision: (fn) => subscribe(this.decisions, fn),
      dispatchStepEvent: async (_event: WorkflowStepEvent) => {},
    };
  }

  /** The pods currently consuming decisions. */
  decisionPods(): string[] {
    return this.decisions.map((c) => c.pod);
  }

  /** Deliver a decision by hand to one pod's consumer (a redelivery, a stale reply, ...). */
  async deliverDecision(pod: string, decision: WorkflowDecision): Promise<void> {
    const consumer = this.decisions.find((c) => c.pod === pod);
    if (!consumer) throw new Error(`pod ${pod} consumes no decisions`);
    await consumer.fn(decision);
  }

  /** Publish a heartbeat to one consumer (a pub/sub or queue lane), like a worker would. */
  async beat(beat: Heartbeat, pod?: string): Promise<void> {
    const consumer = pod ? this.beats.find((c) => c.pod === pod) : this.beats[0];
    await consumer?.fn(beat);
  }

  private async dispatchStep(task: RemoteTask): Promise<void> {
    const result = await runStepHandler(task, this.steps.get(task.name));
    const consumer = this.results[this.resultCursor % Math.max(1, this.results.length)];
    this.resultCursor += 1;
    setImmediate(() => void consumer?.fn(result));
  }

  private async dispatchTurn(pod: string, task: WorkflowTask): Promise<void> {
    this.turns.push({ pod, task });
    if (!this.worker) throw new Error('no workflow worker served');
    const decide = async (): Promise<void> => {
      const decision = await this.worker?.(task);
      if (!decision) return; // the worker died mid-turn: nothing is ever published
      const consumer =
        this.decisions.find((c) => c.pod !== pod) ?? this.decisions.find((c) => c.pod === pod);
      await consumer?.fn(decision);
    };
    if (this.sync) {
      await decide();
      return;
    }
    setImmediate(() => void decide());
  }
}

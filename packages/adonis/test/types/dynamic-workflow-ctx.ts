/**
 * Compile-time guard: every `WorkflowCtx` is usable where code asks for a narrow, NON-overloaded ctx —
 * the exported `DynamicWorkflowCtx`, a `Pick` of it, or a hand-written structural interface of the kind
 * a graph interpreter declares — with no `as unknown as` cast; and a `Pick` of `DynamicWorkflowCtx` is
 * implementable by a plain object literal (a test fake). Checked by `tsc -p tsconfig.tests.json`.
 */
import type { DynamicWorkflowCtx, WorkflowCtx } from '../../src/interfaces.js';

declare const ctx: WorkflowCtx;

export const dynamic: DynamicWorkflowCtx = ctx;

interface InterpreterCtx {
  readonly runId: string;
  localStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(duration: number): Promise<void>;
  sleepUntil(when: Date | number): Promise<void>;
  waitForSignal<T>(token: string, opts?: { timeoutMs?: number }): Promise<T>;
  child<T>(workflow: string, input: unknown, options?: { childId?: string }): Promise<T>;
  all<T>(workflow: string, inputs: unknown[]): Promise<T[]>;
  startChild(workflow: string, input: unknown, options?: { childId?: string }): Promise<string>;
  step<T>(name: string, input: unknown): Promise<T>;
}
export const fromCtx: InterpreterCtx = ctx;
export const fromDynamic: InterpreterCtx = dynamic;

export const fake: Pick<DynamicWorkflowCtx, 'runId' | 'all' | 'child' | 'localStep'> = {
  runId: 'r1',
  all: async <T>(_workflow: string, inputs: unknown[]) => inputs as T[],
  child: async <T>(_workflow: string, input: unknown) => input as T,
  localStep: (_name, fn) => fn({} as never),
};

// @ts-expect-error — `child` on a DynamicWorkflowCtx is string-addressed only.
dynamic.child(class {}, {});

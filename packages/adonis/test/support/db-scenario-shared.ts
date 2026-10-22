/**
 * What the multi-process scenario harness and its worker process share. Kept apart from
 * `db-scenario-worker.ts`, which is an entry point: importing it runs a worker.
 */
export const SCENARIO_STEP = 'scenario.step';
export const SCENARIO_RUNS_TABLE = 'scenario_runs';

export interface Config {
  role: 'worker' | 'schema';
  url: string;
  schema: string;
  instanceId: string;
  concurrency?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  maxStalledCount?: number;
  closeTimeoutMs?: number;
}

export interface StepInput {
  seq: number;
  /** The dispatched task's stepId (handlers are not told it). */
  stepId: string;
  ms?: number;
  msOn?: Record<string, number>;
  die?: boolean;
}

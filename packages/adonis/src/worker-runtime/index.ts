/**
 * `@adonis-agora/durable/worker` — the LEAN, store-less worker entry (design §4 packaging).
 *
 * This module and its whole transitive graph import NO Lucid (and no store at all), so a thin worker
 * pod's dependency graph stays lean without a separate package. That store-less-ness is a STRUCTURAL
 * fact enforced by the `no-lucid` test (test/worker-runtime/no-lucid.spec.ts), not a convention: it
 * walks this module's transitive `import` graph and fails if `@adonisjs/lucid` (or any store module)
 * ever appears. Keep it that way — only add imports that are themselves Lucid-free.
 *
 * A thin worker: build a transport (e.g. the wave-1 `BullMQTransport`), construct a {@link WorkerRuntime}
 * over it, register `app/steps` (and advertise `app/workflows` names) via the re-exported
 * `step-discovery` helpers, then `runtime.start()`. The `node ace durable:worker` command wires exactly
 * this from `config/durable.ts`.
 */

// The handshake descriptor surface (design §7) — re-exported for worker authors; itself Lucid-free.
export {
  CURRENT_PROTOCOL_VERSION,
  descriptorHash,
  type HeartbeatStatus,
  heartbeatStatus,
  normalizeDescriptor,
  type WorkerDescriptor,
  type WorkerLifecycle,
} from '../handshake/descriptor.js';
// The shared pure worker body + step-handler type (the transport funnels tasks through it).
export { runStepHandler, type StepHandler } from '../protocol.js';
// Step registration/discovery helpers (the `app/steps` convention) — Lucid-free (fs + pure metadata).
export {
  collectSteps,
  type DiscoveredStep,
  registerStep,
  registerSteps,
  registerStepsFromBarrel,
  registerStepsFromDir,
  type StepServer,
  type StepsBarrel,
} from '../step-discovery.js';
// The shared pure WORKFLOW-TURN body (replay history → decision) + its authoring surface — what lets a
// store-less worker execute workflow turns (design §4). Itself Lucid-free (imports only interface types).
export {
  type GatherCall,
  type GatherItemError,
  type GatherMode,
  isWorkflowTask,
  type RunWorkflowTurnOptions,
  runWorkflowTurn,
  type WorkflowBody,
  type WorkflowBodyResolver,
  WorkflowGatherFailedError,
  WorkflowNondeterminismError,
  WorkflowStepFailedError,
  WorkflowTurnCancelled,
  type WorkflowTurnCtx,
  type WorkflowTurnHandler,
} from '../workflow-turn.js';
export {
  effectivePrefix,
  routingToken,
  workerDescriptorKey,
  workerDescriptorKeyPrefix,
  workerHeartbeatKey,
} from './naming.js';
export {
  type DescriptorRedis,
  NoopWorkerRegistry,
  RedisWorkerRegistry,
  type WorkerRegistry,
} from './registry.js';
export {
  WORKER_SDK,
  WorkerRuntime,
  type WorkerRuntimeLogger,
  type WorkerRuntimeOptions,
  type WorkerTransport,
} from './worker-runtime.js';

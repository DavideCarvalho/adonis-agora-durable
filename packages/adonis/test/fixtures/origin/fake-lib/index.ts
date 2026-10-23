import type { WorkflowEngine } from '../../../../src/engine.js';
import { registerWorkflowClass } from '../../../../src/workflow-discovery.js';
import { Scheduled } from '../../../../src/workflow-ref.js';

/**
 * Stands in for a workflow shipped by another package: this directory has its own `package.json`, so
 * everything declared or registered from here derives the origin `@fixture/fake-lib` — NOT
 * `@adonis-agora/durable`, which owns the registration code. Nothing here opts into an origin.
 */
export class LibWorkflow {
  static workflow = { name: 'fake-lib-job' };
  async run() {
    return 'lib';
  }
}

/** Declares its own `origin`: an explicit value beats every derived signal. */
export class ExplicitLibWorkflow {
  static workflow = { name: 'fake-lib-explicit', origin: '@acme/explicit' };
  async run() {
    return 'explicit';
  }
}

/** Decorated, so its declaring file is captured at class definition — whoever registers it later. */
@Scheduled({ everyMs: 60_000 })
export class ScheduledLibWorkflow {
  static workflow = { name: 'fake-lib-scheduled' };
  async run() {
    return 'scheduled';
  }
}

/** How a lib wires its workflows into the host's engine: the CALLER of the register APIs is the lib. */
export async function registerFakeLib(engine: WorkflowEngine): Promise<void> {
  await registerWorkflowClass(engine, LibWorkflow);
  await registerWorkflowClass(engine, ExplicitLibWorkflow);
  engine.register('fake-lib-fn', '1', async () => 'fn');
}

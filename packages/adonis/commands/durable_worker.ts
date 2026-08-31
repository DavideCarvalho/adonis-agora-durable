import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { DurableConfig } from '../src/define_config.js';
import type { ControlPlane, Transport } from '../src/interfaces.js';
import { DURABLE_WORKER_RUNTIME } from '../src/role_bindings.js';
import { InMemoryTransport } from '../src/testing/in-memory-transport.js';
import {
  NoopWorkerRegistry,
  registerStepsFromDir,
  WorkerRuntime,
  type WorkerTransport,
} from '../src/worker-runtime/index.js';
import { discoverWorkflows } from '../src/workflow-discovery.js';

/**
 * `node ace durable:worker` — the **store-less** task-consumer loop for a `role: 'tenant'` worker pod
 * (design §3). Distinct from `durable:work` (the store-backed dispatch/recovery/timers loop, which
 * this command deliberately does NOT clobber): a store-less worker owns no durable state — it consumes
 * `${P}-tasks-<token>` tasks (executed through the shared `runStepHandler`, results published) and
 * advertises its {@link import('../src/handshake/descriptor.js').WorkerDescriptor} + heartbeat. Stays
 * alive until SIGINT/SIGTERM, then drains.
 *
 * On a `role: 'tenant'` pod it resolves the **container-bound {@link WorkerRuntime}** the provider wired
 * (design §5): that runtime shares the tenant transport with the `ProxyRunGateway` and carries a
 * `RedisWorkerRegistry` built from the transport's Redis connection, so descriptor + heartbeat are
 * actually published on the shared Redis. Only when no bound runtime exists (a non-tenant role, or a
 * misconfigured pod) does it fall back to building a self-contained runtime from `config/durable.ts`
 * with a {@link NoopWorkerRegistry} (advertising is then a no-op).
 */
export default class DurableWorker extends BaseCommand {
  static override commandName = 'durable:worker';
  static override description =
    'Run the store-less durable worker (consume tasks, execute step bodies, advertise descriptor)';
  static override options: CommandOptions = { startApp: true, staysAlive: true };

  override async run(): Promise<void> {
    const config = this.app.config.get<DurableConfig>('durable', {});
    if (config.role !== 'tenant') {
      this.logger.warning(
        `durable:worker is the store-less worker for role 'tenant'; config.role is '${config.role ?? 'standalone'}'. Continuing, but a store-backed role should use durable:work.`,
      );
    }

    const { runtime, partition } = await this.#resolveRuntime(config);

    // Register `app/steps` (served by the transport) + advertise `app/workflows` names.
    if (config.stepsPath !== false) {
      const stepsDir = this.app.makePath(config.stepsPath ?? 'app/steps');
      const steps = await registerStepsFromDir(runtime, stepsDir);
      this.logger.info(
        `registered ${steps.length} step handler(s) from ${config.stepsPath ?? 'app/steps'}`,
      );
    }
    if (config.workflowsPath !== false) {
      const workflowsDir = this.app.makePath(config.workflowsPath ?? 'app/workflows');
      const workflows = await discoverWorkflows(workflowsDir);
      runtime.registerWorkflowNames(workflows.map((w) => w.meta.name));
      this.logger.info(
        `advertising ${workflows.length} workflow name(s) from ${config.workflowsPath ?? 'app/workflows'}`,
      );
    }

    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const onSignal = (): void => {
      this.logger.info('shutdown signal received — stopping store-less worker…');
      stop();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    await runtime.start();
    this.logger.info(`durable:worker started (partition ${partition})`);
    await stopSignal;
    await runtime.stop();

    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await this.terminate();
  }

  /**
   * Prefer the provider-bound {@link WorkerRuntime} (the `role: 'tenant'` branch of `durable_provider`):
   * it shares the tenant transport with the `ProxyRunGateway` and advertises through a real
   * `RedisWorkerRegistry`. Fall back to a self-built runtime (a {@link NoopWorkerRegistry}) only when the
   * container has no bound runtime — a non-tenant role, or a pod running this command by mistake.
   */
  async #resolveRuntime(
    config: DurableConfig,
  ): Promise<{ runtime: WorkerRuntime; partition: string }> {
    if (this.app.container.hasBinding(DURABLE_WORKER_RUNTIME)) {
      const runtime = await this.app.container.make(DURABLE_WORKER_RUNTIME);
      const partition =
        (config as { partition?: string }).partition ?? config.namespace ?? 'default';
      return { runtime, partition };
    }
    return this.#buildFallbackRuntime(config);
  }

  /** Build a self-contained runtime from `config/durable.ts` (no bound runtime available). Advertising is
   *  a no-op ({@link NoopWorkerRegistry}) — the descriptor is still built + observable, just unpublished. */
  async #buildFallbackRuntime(
    config: DurableConfig,
  ): Promise<{ runtime: WorkerRuntime; partition: string }> {
    const transport = await this.#resolveTransport(config);
    if (typeof (transport as Partial<WorkerTransport>).handle !== 'function') {
      throw new Error(
        `@agora/durable: the selected transport ("${config.transport ?? 'memory'}") cannot serve handlers (no handle()), so a store-less worker has nothing to consume.`,
      );
    }
    transport.useNamespace?.(config.namespace ?? 'default');

    const partition = (config as { partition?: string }).partition ?? config.namespace ?? 'default';

    const runtime = new WorkerRuntime({
      transport: transport as WorkerTransport,
      partition,
      ...(config.namespace !== undefined ? { namespace: config.namespace } : {}),
      ...(config.instanceId !== undefined ? { instanceId: config.instanceId } : {}),
      ...((config as { capabilities?: string[] }).capabilities !== undefined
        ? { capabilities: (config as { capabilities?: string[] }).capabilities }
        : {}),
      registry: new NoopWorkerRegistry(),
      logger: { info: (m) => this.logger.info(m), error: (m) => this.logger.error(m) },
      onError: (err) => this.logger.error(`worker-runtime advertisement error: ${String(err)}`),
    });
    return { runtime, partition };
  }

  /** Build the transport from `config/durable.ts` — the same resolution the provider uses, so the
   *  worker lands on the SAME queues as the control-plane. In-memory default when no transport named. */
  async #resolveTransport(
    config: DurableConfig,
  ): Promise<Transport & Partial<ControlPlane> & Partial<WorkerTransport>> {
    const name = config.transport;
    if (!name) return new InMemoryTransport();
    const factory = config.transports?.[name];
    if (!factory) {
      throw new Error(
        `@agora/durable: config.transport is "${name}", but config.transports.${name} is not defined`,
      );
    }
    return factory({ app: this.app });
  }
}

import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import type { Heartbeat, RemoteTask, StepResult } from '../../src/interfaces.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';

/** A transport under full manual control: dispatch parks the task; the test decides when (and
 *  whether) the "worker" replies. Same shape as `late-result-terminal.spec.ts`. */
class ManualTransport {
  readonly tasks: RemoteTask[] = [];
  #onResult?: (r: StepResult) => Promise<void>;
  async dispatch(task: RemoteTask): Promise<void> {
    this.tasks.push(task);
  }
  onResult(h: (r: StepResult) => Promise<void>): void {
    this.#onResult = h;
  }
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {
    // Sem consumidor: este teste dirige o store diretamente (o pulso que
    // importa é o timer do `timeoutMs`).
  }
  async reply(r: StepResult): Promise<void> {
    await this.#onResult?.(r);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Observado em produção (set/2026, 4 runs de ingestão de laudo): o step
 * EXECUTOU e outra instância do engine consumiu o resultado (fila
 * compartilhada web+worker), gravando o checkpoint como `completed` — mas a
 * promessa in-memory de quem despachou nunca resolveu. O timer estourou
 * DEPOIS da conclusão e o run falhou com `RemoteStepTimeout` sobre um
 * resultado já gravado.
 *
 * No vencimento, o engine deve re-ler o checkpoint: concluído → resolve com o
 * output gravado (cura-se sozinho); pendente → estoura como antes.
 */
describe('timeout with an already-completed checkpoint', () => {
  async function holderWithDispatchedStep() {
    const store = new InMemoryStateStore();
    const transport = new ManualTransport();
    const engine = new WorkflowEngine({ store, transport: transport as never });
    engine.register('ocr', '1', async (ctx) => {
      const out = await ctx.step('pagina', {}, { timeoutMs: 40, retries: 1 });
      return out;
    });
    await engine.start('ocr', {}, 'run-salvo');
    await sleep(10); // dispatch aconteceu, await in-memory armado
    expect(transport.tasks.length).toBe(1);
    const finalPromise = engine.waitForRun('run-salvo', { terminal: true });
    return { store, transport, engine, finalPromise, task: transport.tasks[0]! };
  }

  it('resolve com o output gravado em vez de estourar RemoteStepTimeout', async () => {
    const { store, task, finalPromise } = await holderWithDispatchedStep();

    // Outra instância consumiu o resultado: checkpoint `completed` no store,
    // promessa in-memory do despachante intacta (é exatamente o que o
    // completeRemoteResult de outra instância faz).
    await store.saveCheckpoint({
      runId: task.runId,
      seq: task.seq,
      name: 'pagina',
      kind: 'remote',
      stepId: task.stepId,
      status: 'completed',
      output: { texto: 'lido' },
      attempts: 1,
      enqueuedAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    const final = await finalPromise;
    expect(final.status).toBe('completed');
    expect(final.output).toEqual({ texto: 'lido' });
  });

  it('estoura RemoteStepTimeout normalmente quando o checkpoint segue pendente', async () => {
    const { finalPromise } = await holderWithDispatchedStep();

    const final = await finalPromise;
    expect(final.status).toBe('failed');
  });
});

import type { Transport, WorkflowRun, WorkflowTask } from '../../src/interfaces.js';
import { RemoteWorkflowExecutor } from '../../src/remote-workflow-executor.js';

function run(): WorkflowRun {
  return {
    id: 'r1',
    workflow: 'greet',
    workflowVersion: '1',
    input: 'davi',
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function recordingTransport(): {
  transport: Transport;
  dispatched: WorkflowTask[];
  decisionHandlers: unknown[];
} {
  const dispatched: WorkflowTask[] = [];
  const decisionHandlers: unknown[] = [];
  const transport: Transport = {
    dispatch: async () => {},
    onResult: () => {},
    onHeartbeat: () => {},
    dispatchWorkflowTask: async (t) => {
      dispatched.push(t);
    },
    onDecision: (h) => {
      decisionHandlers.push(h);
    },
  };
  return { transport, dispatched, decisionHandlers };
}

describe('RemoteWorkflowExecutor', () => {
  it('enqueues the turn under the engine-supplied taskId and does not await a decision', async () => {
    const { transport, dispatched } = recordingTransport();
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');

    // Resolves as soon as the task is enqueued: the decision is applied by the engine, not here.
    await exec.dispatch(run(), [], 'r1:wf:abc');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.taskId).toBe('r1:wf:abc');
    expect(dispatched[0]?.group).toBe('py-wf');
    expect(dispatched[0]?.workflow).toBe('greet');
    expect(dispatched[0]?.runId).toBe('r1');
  });

  it("carries the run's priority and the pending signals onto the dispatched workflow task", async () => {
    const { transport, dispatched } = recordingTransport();
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');
    const signals = [{ seq: 2, signal: 'go', payload: { ok: true } }];
    await exec.dispatch({ ...run(), priority: 9 }, [], 'r1:wf:x', signals);
    expect(dispatched[0]?.priority).toBe(9);
    expect(dispatched[0]?.pendingSignals).toEqual(signals);
  });

  it('subscribes the engine handler to the transport once, however often it is asked', () => {
    const { transport, decisionHandlers } = recordingTransport();
    const exec = new RemoteWorkflowExecutor(transport, 'py-wf');
    const handler = async () => {};
    exec.subscribeDecisions(handler);
    exec.subscribeDecisions(handler);
    expect(decisionHandlers).toEqual([handler]);
  });

  it('exposes its timeoutMs as the turn liveness window instead of failing on it', () => {
    const { transport } = recordingTransport();
    expect(new RemoteWorkflowExecutor(transport, 'g', { timeoutMs: 1234 }).decisionTimeoutMs).toBe(
      1234,
    );
    expect(new RemoteWorkflowExecutor(transport, 'g').decisionTimeoutMs).toBeUndefined();
  });

  it('refuses a transport that cannot carry workflow turns', async () => {
    const exec = new RemoteWorkflowExecutor(
      { dispatch: async () => {}, onResult: () => {}, onHeartbeat: () => {} },
      'g',
    );
    await expect(exec.dispatch(run(), [], 't')).rejects.toThrow(/workflow tasks/);
  });
});

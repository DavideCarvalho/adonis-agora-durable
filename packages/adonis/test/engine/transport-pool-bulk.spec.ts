import { describe, expect, it, vi } from 'vitest';
import type { RemoteTask, Transport } from '../../src/interfaces.js';
import { TransportPool } from '../../src/transport-pool.js';

/** A transport that records how it was asked to send, and can refuse either way of sending. */
class Recording implements Transport {
  readonly one: RemoteTask[] = [];
  readonly many: RemoteTask[][] = [];
  constructor(private readonly opts: { refuseOne?: boolean; refuseMany?: boolean } = {}) {}
  async dispatch(task: RemoteTask): Promise<void> {
    if (this.opts.refuseOne) throw new Error('down');
    this.one.push(task);
  }
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    if (this.opts.refuseMany) throw new Error('bulk refused');
    this.many.push(tasks);
  }
  onResult(): void {}
  onHeartbeat(): void {}
}

class OneByOne implements Transport {
  readonly one: RemoteTask[] = [];
  async dispatch(task: RemoteTask): Promise<void> {
    this.one.push(task);
  }
  onResult(): void {}
  onHeartbeat(): void {}
}

const tasks = (n: number): Omit<RemoteTask, 'transport'>[] =>
  Array.from({ length: n }, (_, i) => ({
    runId: 'r1',
    seq: i + 1,
    stepId: `r1:${i + 1}`,
    name: 'lines.process',
    input: { i },
  })) as Omit<RemoteTask, 'transport'>[];

describe('TransportPool.dispatchMany', () => {
  it('sends a fan in one call on a transport that takes many, stamped with its id', async () => {
    const a = new Recording();
    const pool = new TransportPool([{ id: 'a', transport: a }]);
    await pool.dispatchMany(tasks(1000));
    expect(a.many).toHaveLength(1);
    expect(a.many[0]).toHaveLength(1000);
    expect(a.many[0]?.every((t) => t.transport === 'a')).toBe(true);
    expect(a.one).toHaveLength(0);
  });

  it('sends on the preferred transport', async () => {
    const a = new Recording();
    const b = new Recording();
    const pool = new TransportPool([
      { id: 'a', transport: a },
      { id: 'b', transport: b },
    ]);
    await pool.dispatchMany(tasks(3), 'b');
    expect(a.many).toHaveLength(0);
    expect(b.many[0]?.map((t) => t.transport)).toEqual(['b', 'b', 'b']);
  });

  it('a refused bulk send goes task by task, failing over per task', async () => {
    const a = new Recording({ refuseMany: true, refuseOne: true });
    const b = new Recording();
    const pool = new TransportPool([
      { id: 'a', transport: a },
      { id: 'b', transport: b },
    ]);
    await pool.dispatchMany(tasks(450));
    expect(b.one.map((t) => t.seq)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
    expect(b.one.every((t) => t.transport === 'b')).toBe(true);
  });

  it('reports a refused bulk send once, however often it is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = new Recording({ refuseMany: true });
      const pool = new TransportPool([{ id: 'a', transport: a }]);
      await pool.dispatchMany(tasks(3));
      await pool.dispatchMany(tasks(3));
      expect(a.one).toHaveLength(6);
      const reports = warn.mock.calls.filter(([m]) => String(m).includes('bulk dispatch'));
      expect(reports).toHaveLength(1);
      expect(String(reports[0]?.[0])).toContain('bulk refused');
    } finally {
      warn.mockRestore();
    }
  });

  it('a transport without bulk sending gets every task one by one', async () => {
    const a = new OneByOne();
    const pool = new TransportPool([{ id: 'a', transport: a }]);
    await pool.dispatchMany(tasks(5));
    expect(a.one.map((t) => t.stepId)).toEqual(['r1:1', 'r1:2', 'r1:3', 'r1:4', 'r1:5']);
  });

  it('throws when no transport takes a task', async () => {
    const pool = new TransportPool([
      { id: 'a', transport: new Recording({ refuseMany: true, refuseOne: true }) },
    ]);
    await expect(pool.dispatchMany(tasks(2))).rejects.toThrow();
  });
});

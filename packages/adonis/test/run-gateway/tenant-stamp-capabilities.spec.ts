import { beforeEach, describe, expect, it } from 'vitest';
import type { RunReply, VerifiedTenant } from '../../src/index.js';
import type { RunGateway, StartRunOptions } from '../../src/run-gateway/interface.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { FakeP4Transport } from '../helpers/fake-p4-transport.js';

/** One token per grant set; every token verifies to the `acme` partition. */
const TOKENS: Record<string, string[]> = {
  'tok-star': ['*'],
  'tok-tenancy-star': ['tenancy:*'],
  'tok-tenancy-a': ['tenancy:a'],
  'tok-none': [],
};

describe('RunRequestResponder: stamping a customer tenant on a start (capabilityAllows)', () => {
  let transport: FakeP4Transport;
  let started: StartRunOptions[];
  let replies: RunReply[];

  beforeEach(() => {
    transport = new FakeP4Transport();
    started = [];
    replies = [];
    const gateway = {
      start: async (_workflow: unknown, _input: unknown, opts: StartRunOptions = {}) => {
        started.push(opts);
        return { runId: opts.runId ?? 'r', status: 'running' };
      },
    } as unknown as RunGateway;
    const responder = new RunRequestResponder(transport, gateway, {
      verifyTenant: ({ token }): VerifiedTenant | null => {
        const capabilities = token === undefined ? undefined : TOKENS[token];
        return capabilities ? { partition: 'acme', capabilities } : null;
      },
    });
    responder.start();
    transport.onRunReply((r) => replies.push(r));
  });

  async function startAs(token: string, tenantId: string): Promise<StartRunOptions | undefined> {
    await transport.dispatchStartRun({
      tenant: token,
      workflow: 'echo',
      input: null,
      runId: `run-${token}-${tenantId}`,
      tenantId,
      tenantKind: 'organization',
    });
    return started.at(-1);
  }

  it('a token holding `*` stamps any tenant', async () => {
    const opts = await startAs('tok-star', 'b');
    expect(opts).toMatchObject({ namespace: 'acme', tenantId: 'b', tenantKind: 'organization' });
  });

  it('a token holding `tenancy:*` stamps any tenant', async () => {
    expect(await startAs('tok-tenancy-star', 'b')).toMatchObject({ tenantId: 'b' });
  });

  it('`tenancy:a` stamps `a` but not `b`: the run starts without a tenant', async () => {
    expect(await startAs('tok-tenancy-a', 'a')).toMatchObject({ tenantId: 'a' });
    const opts = await startAs('tok-tenancy-a', 'b');
    expect(opts?.namespace).toBe('acme');
    expect(opts?.tenantId).toBeNull();
    expect(opts).not.toHaveProperty('tenantKind');
    expect(replies.at(-1)?.result.ok).toBe(true);
  });

  it('a token without capabilities still starts runs, without a tenant', async () => {
    const opts = await startAs('tok-none', 'a');
    expect(opts).toMatchObject({ namespace: 'acme', tenantId: null });
  });
});

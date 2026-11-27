import { describe, expect, it } from 'vitest';
import type { RunReply, RunRequest, StartRunMessage } from '../../src/interfaces.js';
import {
  ProxyRunGateway,
  type ProxyTransport,
  RunGatewayError,
} from '../../src/run-gateway/proxy-run-gateway.js';
import { resolveTenantToken } from '../../src/run-gateway/tenant-auth.js';

/**
 * A control plane that only accepts `valid`: anything else gets the responder's `unauthorized` reply
 * (an expired token, or one signed by keys the Hub no longer has after a restart).
 */
class StrictWire implements ProxyTransport {
  valid = 'token-2';
  readonly seen: string[] = [];
  #reply: ((reply: RunReply) => void) | undefined;

  #answer(id: string, tenant: string, data: unknown): void {
    this.seen.push(tenant);
    queueMicrotask(() =>
      this.#reply?.(
        tenant === this.valid
          ? { requestId: id, result: { ok: true, data } }
          : {
              requestId: id,
              result: {
                ok: false,
                error: { message: 'invalid or unauthorized tenant token', code: 'unauthorized' },
              },
            },
      ),
    );
  }
  async dispatchRunRequest(msg: RunRequest): Promise<void> {
    this.#answer(msg.requestId, msg.tenant, null);
  }
  async dispatchStartRun(msg: StartRunMessage): Promise<void> {
    this.#answer(msg.runId as string, msg.tenant, { runId: msg.runId, status: 'pending' });
  }
  onRunReply(handler: (reply: RunReply) => void): void {
    this.#reply = handler;
  }
  onTenantEvent(): () => void {
    return () => {};
  }
}

/** authkit-client's `tenantOf(...).token`: cached until `reset()`. */
function cachedToken() {
  let issued = 0;
  let cached: string | undefined;
  const token = Object.assign(
    async () => {
      cached ??= `token-${++issued}`;
      return cached;
    },
    {
      reset: () => {
        cached = undefined;
      },
    },
  );
  return { token, issued: () => issued };
}

describe('tenant token refresh after unauthorized', () => {
  it('drops the cached token and retries once with a fresh one (reads and starts)', async () => {
    const wire = new StrictWire();
    const { token, issued } = cachedToken();
    const proxy = new ProxyRunGateway(wire, {
      partition: 'acme',
      token: resolveTenantToken(token),
      requestTimeoutMs: 1000,
    });

    expect(await proxy.getRun('r1')).toBeNull();
    expect(wire.seen).toEqual(['token-1', 'token-2']);
    expect(issued()).toBe(2);

    // the fresh token is cached: the next call goes straight through
    await proxy.start('wf', {}, { runId: 'run-1' });
    expect(wire.seen).toEqual(['token-1', 'token-2', 'token-2']);

    // the Hub restarts with new keys: the start is retried with the same runId
    wire.valid = 'token-3';
    const result = await proxy.start('wf', {}, { runId: 'run-2' });
    expect(result.runId).toBe('run-2');
    expect(wire.seen.slice(-2)).toEqual(['token-2', 'token-3']);
  });

  it('retries only once: a token the control plane keeps refusing surfaces the error', async () => {
    const wire = new StrictWire();
    wire.valid = 'never';
    const { token, issued } = cachedToken();
    const proxy = new ProxyRunGateway(wire, {
      partition: 'acme',
      token: resolveTenantToken(token),
      requestTimeoutMs: 1000,
    });
    const error = await proxy.getRun('r1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunGatewayError);
    expect((error as RunGatewayError).code).toBe('unauthorized');
    expect(issued()).toBe(2);
  });

  it('a token source without reset() is not retried', async () => {
    const wire = new StrictWire();
    const proxy = new ProxyRunGateway(wire, {
      partition: 'acme',
      token: resolveTenantToken(() => 'token-1'),
      requestTimeoutMs: 1000,
    });
    await expect(proxy.getRun('r1')).rejects.toBeInstanceOf(RunGatewayError);
    expect(wire.seen).toEqual(['token-1']);
  });

  it('resolveTenantToken keeps reset() for objects and credential classes', async () => {
    let resets = 0;
    const object = resolveTenantToken({ get: () => 't', invalidate: () => resets++ });
    expect(typeof object !== 'string' && typeof object.reset).toBe('function');
    if (typeof object !== 'string') object.reset?.();

    class Credentials {
      token() {
        return 't';
      }
      reset() {
        resets++;
      }
    }
    const fromClass = resolveTenantToken(Credentials);
    if (typeof fromClass === 'string') throw new Error('expected a function');
    await fromClass();
    fromClass.reset?.();
    expect(resets).toBe(2);
  });
});

import type { HttpContext } from '@adonisjs/core/http';
import { describe, expect, it } from 'vitest';
import {
  crossSiteRequest,
  isMutatingMethod,
  sessionCanMutate,
} from '../../providers/dashboard_provider.js';
import { CodecStateStore, type PayloadCodec } from '../../src/codec-state-store.js';
import type { TenantVerifier, VerifiedTenant } from '../../src/config_types.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import {
  type Deps,
  getRun,
  listRuns,
  retryWithInputRun,
  signalRun,
} from '../../src/dashboard/handlers.js';
import type { StepCheckpoint } from '../../src/interfaces.js';
import { hmacTenantVerifier, signTenantToken } from '../../src/run-gateway/tenant-auth.js';

/** The HMAC verifier is synchronous — narrow the union for the assertions below. */
const verifySync = (verifier: TenantVerifier, token: string): VerifiedTenant | null =>
  verifier({ token, tenant: token }) as VerifiedTenant | null;

import { InMemoryStateStore, InMemoryTransport, WorkflowEngine } from '../../src/index.js';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

function fakeCtx(opts: { method?: string; headers?: Record<string, string> } = {}): HttpContext {
  const headers = opts.headers ?? {};
  return {
    request: {
      method: () => opts.method ?? 'POST',
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as HttpContext;
}

describe('cross-site rejection on mutating console routes (CSRF defense-in-depth)', () => {
  it('classifies methods', () => {
    expect(isMutatingMethod(fakeCtx({ method: 'GET' }))).toBe(false);
    expect(isMutatingMethod(fakeCtx({ method: 'HEAD' }))).toBe(false);
    expect(isMutatingMethod(fakeCtx({ method: 'POST' }))).toBe(true);
    expect(isMutatingMethod(fakeCtx({ method: 'DELETE' }))).toBe(true);
  });

  it('rejects by sec-fetch-site when the browser sends it', () => {
    expect(crossSiteRequest(fakeCtx({ headers: { 'sec-fetch-site': 'same-origin' } }))).toBe(false);
    expect(crossSiteRequest(fakeCtx({ headers: { 'sec-fetch-site': 'none' } }))).toBe(false);
    expect(crossSiteRequest(fakeCtx({ headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(true);
    // Subdomains count as cross on purpose — the console has no cross-subdomain POST caller.
    expect(crossSiteRequest(fakeCtx({ headers: { 'sec-fetch-site': 'same-site' } }))).toBe(true);
  });

  it('falls back to Origin-vs-Host, and passes header-less non-browser clients', () => {
    expect(
      crossSiteRequest(
        fakeCtx({ headers: { origin: 'https://evil.example', host: 'app.example' } }),
      ),
    ).toBe(true);
    expect(
      crossSiteRequest(
        fakeCtx({ headers: { origin: 'https://app.example', host: 'app.example' } }),
      ),
    ).toBe(false);
    expect(crossSiteRequest(fakeCtx({ headers: { origin: 'null', host: 'app.example' } }))).toBe(
      true, // a sandboxed/opaque origin is exactly the drive-by shape
    );
    expect(crossSiteRequest(fakeCtx())).toBe(false); // curl/SDKs send neither header
  });
});

describe('session role convention on mutating routes', () => {
  it('no roles = full access (back-compat); with roles, operator/admin is required', () => {
    expect(sessionCanMutate({ roles: [] })).toBe(true);
    expect(sessionCanMutate({ roles: ['viewer'] })).toBe(false);
    expect(sessionCanMutate({ roles: ['support', 'viewer'] })).toBe(false);
    expect(sessionCanMutate({ roles: ['viewer', 'operator'] })).toBe(true);
    expect(sessionCanMutate({ roles: ['Admin'] })).toBe(true);
  });
});

describe('console payload caps', () => {
  function makeDeps(): { deps: Deps; raw: WorkflowEngine } {
    const raw = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    raw.register('wf', '1', async (ctx) => {
      await ctx.waitForSignal('go');
      return 'done';
    });
    return { deps: { engine: storeDashboardEngine(raw) }, raw };
  }

  it('413s a fix-and-replay input over 1MiB', async () => {
    const { deps, raw } = makeDeps();
    await raw.start('wf', {}, 'r1');
    await flush();
    const res = await retryWithInputRun(deps, {
      params: { id: 'r1' },
      query: {},
      body: { input: 'x'.repeat(1024 * 1024 + 10) },
    });
    expect(res.status).toBe(413);
  });

  it('413s an oversized signal payload; a normal one still delivers', async () => {
    const { deps, raw } = makeDeps();
    await raw.start('wf', {}, 'r1');
    await flush();
    const big = await signalRun(deps, {
      params: { id: 'r1' },
      query: {},
      body: { token: 'go', payload: 'x'.repeat(1024 * 1024 + 10) },
    });
    expect(big.status).toBe(413);
    const ok = await signalRun(deps, {
      params: { id: 'r1' },
      query: {},
      body: { token: 'go', payload: { fine: true } },
    });
    expect(ok.status).toBe(200);
  });
});

describe('dashboard redaction hooks', () => {
  it('redacts the serialized run/checkpoint shapes on list and detail', async () => {
    const raw = new WorkflowEngine({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
    });
    raw.register('wf', '1', async (ctx) => {
      await ctx.localStep('charge', async () => ({ card: '4242' }));
      return { secret: 'pii' };
    });
    const deps: Deps = {
      engine: storeDashboardEngine(raw),
      redact: {
        run: (run) => ({ ...run, output: '[redacted]', input: '[redacted]' }),
        checkpoint: (cp) => ({ ...cp, output: '[redacted]' }),
      },
    };
    await raw.start('wf', { card: '4242' }, 'r1');
    await flush();

    const list = (await listRuns(deps, { params: {}, query: {} })).body as {
      runs: Array<Record<string, unknown>>;
    };
    expect(list.runs[0]?.output).toBe('[redacted]');

    const detail = (await getRun(deps, { params: { id: 'r1' }, query: {} })).body as {
      run: Record<string, unknown>;
      timeline: Array<Record<string, unknown>>;
    };
    expect(detail.run.input).toBe('[redacted]');
    expect(detail.run.output).toBe('[redacted]');
    expect(detail.timeline[0]?.output).toBe('[redacted]');
  });
});

describe('CodecStateStore extended coverage', () => {
  const marker = (v: unknown) => ({ __enc: v });
  const codec: PayloadCodec = {
    encode: (v) => marker(v),
    decode: (v) =>
      v && typeof v === 'object' && '__enc' in v ? (v as { __enc: unknown }).__enc : v,
  };
  const cp = (over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
    runId: 'r1',
    seq: 0,
    name: 'step',
    kind: 'local',
    stepId: 'r1:0',
    status: 'failed',
    input: { a: 1 },
    output: { b: 2 },
    error: { message: 'card 4242 declined' },
    events: [{ at: 1, level: 'info', message: 'sensitive log line' } as never],
    heartbeatProgress: { row: 5 },
    attempts: 1,
    enqueuedAt: new Date(1000),
    startedAt: new Date(1000),
    finishedAt: new Date(1000),
    ...over,
  });

  it("default coverage leaves events/error/heartbeat in the clear (the documented gap), extended doesn't", async () => {
    const innerDefault = new InMemoryStateStore();
    const byDefault = new CodecStateStore(innerDefault, codec);
    await byDefault.saveCheckpoint(cp());
    const storedDefault = await innerDefault.getCheckpoint('r1', 0);
    expect(storedDefault?.input).toEqual(marker({ a: 1 })); // payloads: encoded
    expect(storedDefault?.error).toEqual({ message: 'card 4242 declined' }); // clear!
    expect(storedDefault?.events?.[0]).toMatchObject({ message: 'sensitive log line' }); // clear!

    const innerExt = new InMemoryStateStore();
    const extended = new CodecStateStore(innerExt, codec, { coverage: 'extended' });
    await extended.saveCheckpoint(cp());
    const storedExt = await innerExt.getCheckpoint('r1', 0);
    expect(storedExt?.error).toEqual(marker({ message: 'card 4242 declined' }));
    expect(storedExt?.events).toEqual(marker(cp().events));
    expect(storedExt?.heartbeatProgress).toEqual(marker({ row: 5 }));
    // …and reads through the wrapper come back decoded, so the engine's retry logic still works.
    const read = await extended.getCheckpoint('r1', 0);
    expect(read?.error).toEqual({ message: 'card 4242 declined' });
    expect(read?.heartbeatProgress).toEqual({ row: 5 });
  });

  it('forwards recordStepHeartbeat (previously silently dropped), encoding progress when extended', async () => {
    const inner = new InMemoryStateStore();
    const extended = new CodecStateStore(inner, codec, { coverage: 'extended' });
    await extended.saveCheckpoint(cp({ status: 'pending' }));
    await extended.recordStepHeartbeat('r1', 0, new Date(2000), { pct: 50 });
    expect((await inner.getCheckpoint('r1', 0))?.heartbeatProgress).toEqual(marker({ pct: 50 }));
  });
});

describe('tenant tokens — expiry and secret rotation', () => {
  it('legacy tokens keep verifying; expiring tokens verify until their instant, then reject', () => {
    const verify = hmacTenantVerifier('s3cret');
    const legacy = signTenantToken('acme', 's3cret');
    expect(verifySync(verify, legacy)?.tenant).toBe('acme');

    const live = signTenantToken('acme', 's3cret', { ttlMs: 60_000 });
    expect(verifySync(verify, live)?.tenant).toBe('acme');

    const expired = signTenantToken('acme', 's3cret', { ttlMs: 60_000, now: Date.now() - 120_000 });
    expect(verifySync(verify, expired)).toBeNull();
  });

  it('the expiry is inside the signature — stripping or extending it rejects', () => {
    const verify = hmacTenantVerifier('s3cret');
    const token = signTenantToken('acme', 's3cret', { ttlMs: 1_000, now: Date.now() - 120_000 });
    const sig = token.slice(token.lastIndexOf('.') + 1);
    expect(verifySync(verify, `acme.${sig}`)).toBeNull(); // stripped
    const extended = `acme.exp${Date.now() + 999_999}.${sig}`;
    expect(verifySync(verify, extended)).toBeNull(); // extended
  });

  it('accepts a secret LIST for two-step rotation', () => {
    const old = signTenantToken('acme', 'old-secret');
    const fresh = signTenantToken('acme', 'new-secret');
    const verify = hmacTenantVerifier(['new-secret', 'old-secret']);
    expect(verifySync(verify, old)?.tenant).toBe('acme');
    expect(verifySync(verify, fresh)?.tenant).toBe('acme');
    expect(verifySync(hmacTenantVerifier(['new-secret']), old)).toBeNull();
  });
});

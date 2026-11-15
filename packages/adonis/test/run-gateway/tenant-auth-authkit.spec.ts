import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authkitTenantToken, authkitTenantVerifier } from '@adonis-agora/authkit-client';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../src/engine.js';
import { ProxyRunGateway } from '../../src/run-gateway/proxy-run-gateway.js';
import { RunRequestResponder } from '../../src/run-gateway/run-request-responder.js';
import { StoreRunGateway } from '../../src/run-gateway/store-run-gateway.js';
import { resolveTenantToken, resolveTenantVerifier } from '../../src/run-gateway/tenant-auth.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { FakeP4Transport } from '../helpers/fake-p4-transport.js';

/**
 * The remote tenant-auth path of the "Authenticate tenants" guide: a control plane verifies tenant
 * tokens with authkit-client's `authkitTenantVerifier`, a tenant fetches them with
 * `authkitTenantToken`, and neither runs authkit-server. A local HTTP server stands in for the issuer:
 * discovery document, JWKS and a `client_credentials` token endpoint.
 */

const RESOURCE = 'urn:agora:durable';

type Key = { kid: string; privateKey: CryptoKey; jwk: JWK };

async function makeKey(kid: string): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  return {
    kid,
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' },
  };
}

class LocalIssuer {
  server!: Server;
  issuer = '';
  key!: Key;
  tokenRequests: URLSearchParams[] = [];
  /** Claims the token endpoint puts on the next token (on top of the standard ones). */
  tokenClaims: Record<string, unknown> = { partition: 'acme', capabilities: ['tenancy:*'] };

  async start(): Promise<void> {
    this.key = await makeKey('k1');
    this.server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  sign(claims: Record<string, unknown>, opts: { expSec?: number; typ?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: this.issuer,
      aud: RESOURCE,
      sub: 'svc-acme',
      client_id: 'svc-acme',
      ...claims,
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.key.kid, typ: opts.typ ?? 'at+jwt' })
      .setIssuedAt(now)
      .setExpirationTime(now + (opts.expSec ?? 600))
      .sign(this.key.privateKey);
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(
        JSON.stringify({
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          jwks_uri: `${this.issuer}/keys`,
          // Not `/oauth/token`: the helpers must find it by discovery.
          token_endpoint: `${this.issuer}/connect/token`,
        }),
      );
      return;
    }
    if (req.url === '/keys') {
      res.end(JSON.stringify({ keys: [this.key.jwk] }));
      return;
    }
    if (req.url === '/connect/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = new URLSearchParams(raw);
      this.tokenRequests.push(body);
      const token = await this.sign({ aud: body.get('resource') ?? RESOURCE, ...this.tokenClaims });
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 600 }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  }
}

const issuer = new LocalIssuer();
beforeAll(() => issuer.start());
afterAll(() => issuer.stop());
beforeEach(() => {
  issuer.tokenRequests = [];
  issuer.tokenClaims = { partition: 'acme', capabilities: ['tenancy:*'] };
});

describe('authkitTenantVerifier as verifyTenant', () => {
  const verifier = () =>
    resolveTenantVerifier(authkitTenantVerifier({ issuer: issuer.issuer, resource: RESOURCE }));

  it('accepts a valid token: partition and capabilities come from the token', async () => {
    const token = await issuer.sign({ partition: 'acme', capabilities: ['tenancy:*'] });
    expect(await verifier()({ token, partition: 'globex' })).toEqual({
      partition: 'acme',
      capabilities: ['tenancy:*'],
    });
  });

  it('refuses a token for another resource (wrong aud)', async () => {
    const token = await issuer.sign({ partition: 'acme', aud: 'urn:agora:flags' });
    expect(await verifier()({ token })).toBeNull();
  });

  it('refuses a token without a partition', async () => {
    expect(await verifier()({ token: await issuer.sign({}) })).toBeNull();
    expect(await verifier()({ token: await issuer.sign({ partition: '' }) })).toBeNull();
  });

  it('refuses an environment mismatch when the control plane pins one', async () => {
    const pinned = resolveTenantVerifier(
      authkitTenantVerifier({
        issuer: issuer.issuer,
        resource: RESOURCE,
        environment: 'production',
      }),
    );
    const prod = await issuer.sign({ partition: 'acme', environment: 'production' });
    expect(await pinned({ token: prod })).toEqual({
      partition: 'acme',
      environment: 'production',
      capabilities: [],
    });
    expect(
      await pinned({ token: await issuer.sign({ partition: 'acme', environment: 'staging' }) }),
    ).toBeNull();
    expect(await pinned({ token: await issuer.sign({ partition: 'acme' }) })).toBeNull();
  });

  it('refuses an expired token, a wrong issuer, a user token and garbage', async () => {
    const v = verifier();
    expect(
      await v({ token: await issuer.sign({ partition: 'acme' }, { expSec: -120 }) }),
    ).toBeNull();
    expect(
      await v({ token: await issuer.sign({ partition: 'acme', iss: 'https://evil' }) }),
    ).toBeNull();
    expect(await v({ token: await issuer.sign({ partition: 'acme', sub: 'user-1' }) })).toBeNull();
    expect(await v({ token: 'not-a-jwt' })).toBeNull();
    expect(await v({})).toBeNull();
  });
});

describe('authkitTenantToken as tenant.token', () => {
  it('gets a client_credentials token for the resource from the discovered endpoint', async () => {
    const token = resolveTenantToken(
      authkitTenantToken({
        issuer: issuer.issuer,
        clientId: 'svc-acme',
        clientSecret: 's3cret',
        resource: RESOURCE,
      }),
    ) as () => Promise<string>;
    const first = await token();
    expect(await token()).toBe(first); // cached
    expect(issuer.tokenRequests).toHaveLength(1);
    expect(issuer.tokenRequests[0]?.get('grant_type')).toBe('client_credentials');
    expect(issuer.tokenRequests[0]?.get('resource')).toBe(RESOURCE);
  });
});

describe('end to end over the wire: tenant pod ⇄ control plane, authkit on neither', () => {
  function cluster() {
    const transport = new FakeP4Transport();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), namespace: 'acme' });
    engine.register('echo', '1', async (_ctx, input) => input);
    new RunRequestResponder(transport, new StoreRunGateway(engine, { topology: 'control-plane' }), {
      verifyTenant: resolveTenantVerifier(
        authkitTenantVerifier({ issuer: issuer.issuer, resource: RESOURCE }),
      ),
      subscribeEngineEvents: (listener) => engine.subscribe(listener),
    }).start();
    const pod = (partition: string) =>
      new ProxyRunGateway(transport, {
        partition,
        token: resolveTenantToken(
          authkitTenantToken({
            issuer: issuer.issuer,
            clientId: 'svc-acme',
            clientSecret: 's3cret',
            resource: RESOURCE,
          }),
        ),
        requestTimeoutMs: 2_000,
      });
    return { engine, pod };
  }

  it('the run lands in the partition the token names, and the pod reads it back', async () => {
    const { engine, pod } = cluster();
    const acme = pod('acme');
    const started = await acme.start('echo', { ok: true });
    await engine.waitForRun(started.runId);
    expect((await acme.getRun(started.runId))?.namespace).toBe('acme');
  });

  it('a token for another resource is answered unauthorized', async () => {
    const { pod } = cluster();
    issuer.tokenClaims = { partition: 'acme', aud: 'urn:agora:flags' };
    await expect(pod('acme').listRuns({})).rejects.toThrow(/unauthorized|invalid/i);
  });
});

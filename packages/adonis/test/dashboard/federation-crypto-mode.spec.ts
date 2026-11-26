import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConsoleCipher,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/control-plane-redis/console-auth.js';
import { RedisControlPlane } from '../../src/control-plane-redis/index.js';
import { answerConsoleCommands, FederatedApp } from '../../src/dashboard/federation.js';
import { storeDashboardEngine } from '../../src/dashboard/gateway-adapter.js';
import { WorkflowEngine } from '../../src/engine.js';
import type { ConsoleCommand, TenantVerifier } from '../../src/index.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { RedisBus, settle } from '../support/redis-bus.js';

/**
 * A stand-in for an @adonis-agora/crypto server (in the Hub or its own app): keys live here, and
 * each caller gets a cipher limited to what its token may do on them.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([['console-durable', randomBytes(32)]]);
  readonly audit: Array<{ op: string; key: string; context?: string | undefined }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): ConsoleCipher {
    return {
      encrypt: async ({ key, plaintext, aad, context }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key)!, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key, context });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad, context }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.keys.get(key)!, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key, context });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

const verifyTenant: TenantVerifier = ({ token }) =>
  token === 'hub-writer' ? { partition: 'shop', capabilities: ['durable:*'] } : null;

const planes: RedisControlPlane[] = [];
afterEach(async () => {
  for (const p of planes.splice(0)) await p.close();
});

function plane(bus: RedisBus) {
  const p = new RedisControlPlane({
    connection: bus.connection(),
    prefix: 'shop',
    pingIntervalMs: 0,
  });
  planes.push(p);
  return p;
}

async function setup(options: { verify?: boolean } = {}) {
  const bus = new RedisBus();
  const server = new FakeCryptoServer();
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, instanceId: 'shop' });
  engine.register('approval', '1', async (ctx) => ctx.waitForSignal('approve'));
  await engine.start('approval', {}, 'run-1');
  await settle();
  const seen: ConsoleCommand[] = [];
  const errors: unknown[] = [];
  const owner = plane(bus);
  const answer = owner.onConsoleCommand.bind(owner);
  owner.onConsoleCommand = (handler, opts) =>
    answer((command) => {
      seen.push(command);
      return handler(command);
    }, opts);
  // The app: may only decrypt with the key (its crypto token: crypto:decrypt:console-durable).
  answerConsoleCommands(owner, storeDashboardEngine(engine), undefined, {
    auth: {
      crypto: { cipher: server.cipherFor({ decrypt: ['console-durable'] }) },
      ...(options.verify ? { verifyTenant } : {}),
    },
    partition: 'shop',
    actions: true,
    onError: (error) => errors.push(error),
  });
  // The console: may only encrypt with it (in the Hub: serviceCipher(crypto.service, 'shop')).
  let resolved = 0;
  const console = (token?: string) =>
    new FederatedApp({
      id: 'shop',
      store,
      controlPlane: plane(bus),
      timeoutMs: 1_000,
      auth: {
        crypto: {
          // Lazy, like `() => crypto.client!` in config/durable_dashboard.ts.
          cipher: () => {
            resolved += 1;
            return server.cipherFor({ encrypt: ['console-durable'] });
          },
        },
        ...(token !== undefined ? { token } : {}),
      },
    }).engine('alice@hub');
  return { bus, server, engine, seen, errors, console, resolvedCount: () => resolved };
}

describe('federated console, sealed with @adonis-agora/crypto', () => {
  it('runs a command the console encrypted and the app decrypted, with nothing readable on Redis', async () => {
    const { bus, server, engine, seen, console, resolvedCount } = await setup();
    const hub = console();
    expect(resolvedCount()).toBe(0);
    expect(await hub.cancel('run-1')).not.toBeNull();
    expect(resolvedCount()).toBe(1);
    expect((await engine.getRun('run-1'))?.status).toBe('cancelled');
    expect(seen[0]).toMatchObject({ verb: 'cancel', actor: 'alice@hub' });
    expect(seen[0]?.verified).toBeUndefined();
    const commands = bus.published
      .filter((p) => p.channel === 'shop-console')
      .map((p) => p.message);
    expect(commands.join('\n')).not.toContain('run-1');
    expect(commands.join('\n')).not.toContain('alice@hub');
    // Crypto audits both sides, with the command's channel and id as context.
    expect(server.audit.map((row) => row.op)).toEqual(['encrypt', 'decrypt']);
    expect(server.audit[0]?.context).toContain('agora:console-command');
  });

  it('refuses commands from someone who cannot encrypt with the key', async () => {
    const { bus, server, engine, seen, errors } = await setup();
    const raw = bus.connection();
    // Another key of theirs, a made-up ciphertext under the right name, and a plain command.
    server.keys.set('mine', randomBytes(32));
    const theirs = server.cipherFor({ encrypt: ['mine'] });
    const { ciphertext } = await theirs.encrypt({ key: 'mine', plaintext: '{}', aad: 'x' });
    await raw.publish(
      'shop-console',
      JSON.stringify({ id: crypto.randomUUID(), sealed: ciphertext }),
    );
    await raw.publish(
      'shop-console',
      JSON.stringify({
        id: crypto.randomUUID(),
        sealed: `agora:ct1:console-durable:1:${randomBytes(64).toString('base64url')}`,
      }),
    );
    await raw.publish(
      'shop-console',
      JSON.stringify({ id: crypto.randomUUID(), verb: 'cancel', args: ['run-1'] }),
    );
    await settle(30);
    expect(seen).toHaveLength(0);
    expect(errors).toHaveLength(3);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
    expect((await engine.getRun('run-1'))?.status).toBe('suspended');
  });

  it('with verifyTenant on the app, the command must also carry a valid token', async () => {
    const { seen, console } = await setup({ verify: true });
    await expect(console().workerHealth()).rejects.toMatchObject({ code: UNAUTHORIZED_CONSOLE });
    expect(Array.isArray(await console('hub-writer').workerHealth())).toBe(true);
    expect(seen.at(-1)?.verified).toEqual({ partition: 'shop', capabilities: ['durable:*'] });
  });

  it('ignores a forged answer', async () => {
    const { bus, console } = await setup();
    const raw = bus.connection();
    await raw.subscribe('shop-console', (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish('shop-console-reply', JSON.stringify({ id, ok: true, data: ['forged'] }));
    });
    expect(await console().workerHealth()).not.toEqual(['forged']);
  });

  it('says so when crypto is not ready yet', async () => {
    const bus = new RedisBus();
    await expect(
      plane(bus).sendConsoleCommand(
        { id: '1', verb: 'cancel', args: ['r'] },
        { auth: { crypto: { cipher: () => undefined as never } }, timeoutMs: 100 },
      ),
    ).rejects.toThrow(/crypto\.cipher.*not ready/);
  });
});

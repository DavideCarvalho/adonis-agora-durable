import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  CryptoPrincipalLike,
  CryptoRuntimeLike,
} from '../../src/control-plane-redis/console-crypto.js';

/** Whether `granted` holds `required` (exact, or a trailing `*` prefix wildcard, like crypto's). */
function holds(granted: readonly string[], required: string): boolean {
  return granted.some(
    (g) => g === required || (g.endsWith('*') && required.startsWith(g.slice(0, -1))),
  );
}

/**
 * A stand-in for an `@adonis-agora/crypto` server: keys per partition, every call checked against
 * the caller's capabilities, and an audit of what happened. `runtime()` gives what the crypto
 * provider binds as `'agora.crypto'` — embedded (with `service`) or a tenant (operations only, over
 * "the network").
 */
export class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>();
  readonly audit: Array<{ op: string; partition: string; key: string; actor: string }> = [];
  /** `false`: a server too old to seal for another partition (refuses `partition`). */
  sealsForOthers = true;

  #key(partition: string, name: string): Buffer {
    const key = this.keys.get(`${partition}/${name}`);
    if (!key) throw new Error(`crypto: key "${name}" not found in ${partition}`);
    return key;
  }

  createKeyIn(partition: string, name: string): void {
    this.keys.set(`${partition}/${name}`, randomBytes(32));
  }

  hasKey(partition: string, name: string): boolean {
    return this.keys.has(`${partition}/${name}`);
  }

  readonly service: NonNullable<CryptoRuntimeLike['service']> = {
    encrypt: async (principal, input) => this.#encrypt(principal, input, 'encrypt'),
    decrypt: async (principal, input) => this.#decrypt(principal, input),
    createKey: async (principal, input) => {
      if (!holds(principal.capabilities, `crypto:keys:manage:${input.name}`)) {
        throw new Error(`forbidden: crypto:keys:manage:${input.name}`);
      }
      if (this.hasKey(principal.partition, input.name)) {
        throw new Error(`crypto: key "${input.name}" already exists`);
      }
      this.createKeyIn(principal.partition, input.name);
      this.audit.push({
        op: 'createKey',
        partition: principal.partition,
        key: input.name,
        actor: principal.actor,
      });
      return { name: input.name };
    },
    store: {
      getKey: async (partition, name) => (this.hasKey(partition, name) ? { name } : null),
    },
  };

  #encrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; plaintext: string; aad?: string },
    capability: 'encrypt' | 'seal',
  ): { ciphertext: string } {
    if (!holds(principal.capabilities, `crypto:${capability}:${input.key}`)) {
      throw new Error(`forbidden: crypto:${capability}:${input.key}`);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key(principal.partition, input.key), iv);
    cipher.setAAD(Buffer.from(input.aad ?? ''));
    const body = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
    this.audit.push({
      op: capability,
      partition: principal.partition,
      key: input.key,
      actor: principal.actor,
    });
    return {
      ciphertext: `agora:ct1:${input.key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
    };
  }

  #decrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; ciphertext: string; aad?: string },
  ): { plaintext: string } {
    // §2e.A: an app opens its own `console-*` keys with no grant (never another partition's).
    const ownConsoleKey = input.key.startsWith('console-');
    if (!ownConsoleKey && !holds(principal.capabilities, `crypto:decrypt:${input.key}`)) {
      throw new Error(`forbidden: crypto:decrypt:${input.key}`);
    }
    const raw = Buffer.from(input.ciphertext.split(':').pop()!, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key(principal.partition, input.key),
      raw.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(input.aad ?? ''));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    this.audit.push({
      op: 'decrypt',
      partition: principal.partition,
      key: input.key,
      actor: principal.actor,
    });
    return { plaintext: plaintext.toString('utf8') };
  }

  /**
   * The `'agora.crypto'` runtime of the app of `partition`: embedded (this server runs in it, with
   * `service`; its own operations hold `crypto:*`), or a tenant whose token holds `grants`.
   */
  runtime(
    partition: string,
    options: {
      embedded?: boolean;
      grants?: string[];
      /** Every decrypt is refused (a token for the wrong partition, an old server). */
      refuse?: boolean;
      /** While `down.value`, the server is unreachable. */
      down?: { value: boolean };
      /** `'yes'`: operations have `hasKey` (§13f); `'old'`: they have it but it throws (older server). */
      hasKey?: 'yes' | 'old';
    } = {},
  ): CryptoRuntimeLike {
    const embedded = options.embedded === true;
    const grants = embedded ? ['crypto:*'] : (options.grants ?? []);
    const me: CryptoPrincipalLike = { partition, capabilities: grants, actor: `app:${partition}` };
    return {
      topology: embedded ? 'standalone' : 'tenant',
      partition,
      ...(embedded ? { service: this.service } : {}),
      operations: {
        encrypt: async (input) => {
          const { partition: target, ...rest } = input;
          if (target !== undefined && target !== partition) {
            if (!this.sealsForOthers) throw new Error('unknown field "partition"');
            return this.#encrypt({ ...me, partition: target }, rest, 'seal');
          }
          return this.#encrypt(me, rest, 'encrypt');
        },
        decrypt: async (input) => {
          if (options.down?.value) throw new Error('connect ECONNREFUSED 127.0.0.1:3333');
          if (options.refuse) throw new Error(`forbidden: crypto:decrypt:${input.key}`);
          return this.#decrypt(me, input);
        },
        createKey: async (input) => this.service.createKey(me, input),
        ...(options.hasKey
          ? {
              hasKey: async ({ key }: { key: string }) => {
                if (options.hasKey === 'old') throw new Error('404 route not found: /keys/has');
                if (options.refuse) throw new Error(`forbidden: crypto:decrypt:${key}`);
                this.audit.push({ op: 'hasKey', partition, key, actor: me.actor });
                return this.hasKey(partition, key);
              },
            }
          : {}),
      },
    };
  }
}

/** A fake `'authkit.client'` with calls between apps: tokens it issues, and their verification. */
export class FakeAuthkit {
  /** The capabilities authkit granted the console app (`hub`) on each app. */
  constructor(
    readonly self: string,
    readonly grants: Record<string, string[]> = {},
  ) {}
  readonly issued: string[] = [];
  resets = 0;
  /** When set, minting an app-call token fails with this message (no grant, invalid_target…). */
  failTokens: string | undefined;
  mintAttempts = 0;

  appCallTokens() {
    return {
      token: async (app: string) => {
        this.mintAttempts += 1;
        if (this.failTokens) throw new Error(this.failTokens);
        const token = `appcall:${this.self}->${app}`;
        this.issued.push(token);
        return token;
      },
      reset: () => {
        this.resets += 1;
      },
    };
  }

  appCallerVerifier() {
    return {
      verifyToken: async (token: string) => {
        const match = /^appcall:(.+)->(.+)$/.exec(token);
        // The audience must be this app.
        if (!match || match[2] !== this.self) return null;
        const caller = match[1] as string;
        return {
          app: caller,
          capabilities: this.grants[caller] ?? [],
          clientId: `client-${caller}`,
          expiresAt: Date.now() + 60_000,
        };
      },
    };
  }
}

/** A fake authkit key directory: what apps published, by app and purpose (public JWKs only). */
export class FakeKeyDirectory {
  readonly keys = new Map<string, { kty: 'OKP'; crv: string; x: string }>();
  lookups = 0;
}

/** A fake `'authkit.client'` with calls between apps AND the key directory (§2e.B). */
export class FakeAuthkitWithDirectory extends FakeAuthkit {
  constructor(
    self: string,
    readonly directory: FakeKeyDirectory,
    grants: Record<string, string[]> = {},
  ) {
    super(self, grants);
  }

  async publishAppKey(input: { purpose: string; jwk: { kty: 'OKP'; crv: string; x: string } }) {
    this.directory.keys.set(`${this.self}/${input.purpose}`, { ...input.jwk });
  }

  async appKey(input: { app: string; purpose: string }) {
    this.directory.lookups += 1;
    return this.directory.keys.get(`${input.app}/${input.purpose}`) ?? null;
  }
}

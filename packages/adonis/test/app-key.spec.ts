import { defineConfig, drivers } from '@adonisjs/core/encryption';
import { Secret } from '@adonisjs/core/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppKey, appKeyOf } from '../src/app_key.js';
import { consoleCommandPublicKey } from '../src/control-plane-redis/console-auth.js';

/**
 * APP_KEY resolution (SECURITY-UNIFORM-SPEC §13c, identical in every lib): `config/app.ts`'s
 * `appKey` → the default entry of `config/encryption.ts` (AdonisJS 7) → `process.env.APP_KEY`.
 */
const KEY = 'app-key-from-config-0123456789';
const ENCRYPTION_KEY = 'app-key-from-encryption-012345';
const ENV_KEY = 'app-key-from-the-environment-0';

const appWith = (config: Record<string, unknown>) => ({
  config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
});
const release = (value: AppKey | undefined) =>
  typeof value === 'string' ? value : value?.release();

const savedEnv = process.env.APP_KEY;
beforeEach(() => {
  delete process.env.APP_KEY;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.APP_KEY;
  else process.env.APP_KEY = savedEnv;
});

describe('appKeyOf', () => {
  it('reads config/app.ts appKey, as a string or a Secret', async () => {
    expect(release(await appKeyOf(appWith({ 'app.appKey': KEY })))).toBe(KEY);
    const secret = new Secret(KEY);
    expect(await appKeyOf(appWith({ 'app.appKey': secret }))).toBe(secret);
  });

  it('reads the default entry of config/encryption.ts (AdonisJS 7 defineConfig + drivers)', async () => {
    // EduLiberta's file: the key only lives here.
    const legacy = defineConfig({
      default: 'legacy',
      list: { legacy: drivers.legacy({ keys: [new Secret(ENCRYPTION_KEY)] }) },
    });
    expect(release(await appKeyOf(appWith({ encryption: legacy })))).toBe(ENCRYPTION_KEY);
    const several = defineConfig({
      default: 'app',
      list: {
        backup: drivers.aes256gcm({ id: 'backup', keys: ['backup-key-0123456789abcdef'] }),
        app: drivers.aes256gcm({ id: 'app', keys: [ENCRYPTION_KEY, 'old-key-0123456789abcdef'] }),
      },
    });
    expect(release(await appKeyOf(appWith({ encryption: several })))).toBe(ENCRYPTION_KEY);
    const noDefault = defineConfig({
      list: { only: drivers.aes256gcm({ id: 'only', keys: [ENCRYPTION_KEY] }) },
    });
    expect(release(await appKeyOf(appWith({ encryption: noDefault })))).toBe(ENCRYPTION_KEY);
  });

  it('reads already-resolved and flat encryption configs (keys or key)', async () => {
    const resolvedList = { default: 'a', list: { a: { keys: [ENCRYPTION_KEY] } } };
    expect(release(await appKeyOf(appWith({ encryption: resolvedList })))).toBe(ENCRYPTION_KEY);
    const singleKey = { default: 'a', list: { a: { key: new Secret(ENCRYPTION_KEY) } } };
    expect(release(await appKeyOf(appWith({ encryption: singleKey })))).toBe(ENCRYPTION_KEY);
    expect(release(await appKeyOf(appWith({ encryption: { keys: [ENCRYPTION_KEY] } })))).toBe(
      ENCRYPTION_KEY,
    );
  });

  it('falls back to process.env.APP_KEY, in order', async () => {
    process.env.APP_KEY = ENV_KEY;
    const encryption = defineConfig({
      default: 'a',
      list: { a: drivers.aes256gcm({ id: 'a', keys: [ENCRYPTION_KEY] }) },
    });
    expect(release(await appKeyOf(appWith({ 'app.appKey': KEY, encryption })))).toBe(KEY);
    expect(release(await appKeyOf(appWith({ encryption })))).toBe(ENCRYPTION_KEY);
    expect(await appKeyOf(appWith({}))).toBe(ENV_KEY);
    const empty = defineConfig({ list: { a: drivers.aes256gcm({ id: 'a', keys: [''] }) } });
    expect(await appKeyOf(appWith({ encryption: empty }))).toBe(ENV_KEY);
  });

  it('is undefined with no source, and survives a throwing config', async () => {
    expect(await appKeyOf(appWith({}))).toBeUndefined();
    const broken = {
      config: {
        get: () => {
          throw new Error('boom');
        },
      },
    };
    expect(await appKeyOf(broken)).toBeUndefined();
    const failing = { type: 'provider', resolver: async () => Promise.reject(new Error('x')) };
    expect(await appKeyOf(appWith({ encryption: failing }))).toBeUndefined();
  });

  it('the same APP_KEY gives the same console-command key from every source', async () => {
    const fromEncryption = await appKeyOf(
      appWith({
        encryption: defineConfig({
          default: 'legacy',
          list: { legacy: drivers.legacy({ keys: [new Secret(KEY)] }) },
        }),
      }),
    );
    const fromApp = await appKeyOf(appWith({ 'app.appKey': KEY }));
    expect(consoleCommandPublicKey(fromEncryption!, 'shop')).toBe(
      consoleCommandPublicKey(fromApp!, 'shop'),
    );
  });
});

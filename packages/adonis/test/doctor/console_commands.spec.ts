import { describe, expect, it } from 'vitest';
import {
  checkConsoleCommands,
  checkConsoleCommandsCrypto,
} from '../../src/doctor/console_commands.js';
import { InMemoryStateStore } from '../../src/testing/in-memory-state-store.js';
import { FakeAuthkit, FakeCryptoServer } from '../support/fake-crypto-runtime.js';

/** A booted app as the doctor sees it: its config, and the siblings bound in its container. */
function fakeApp(config: Record<string, unknown>, bindings: Record<string, unknown> = {}) {
  return {
    config: { get: (key: string, fallback?: unknown) => config[key] ?? fallback },
    container: {
      hasBinding: (key: string) => Object.hasOwn(bindings, key),
      make: async (key: string) => bindings[key],
    },
  } as never;
}

const controlPlane = { sendConsoleCommand: async () => ({ id: '', ok: true, data: null }) };

describe('agora:doctor — durable.console-commands', () => {
  it('is an error when either side resolves no authentication, with the line to add', async () => {
    const results = await checkConsoleCommands(
      fakeApp({
        durable: { consoleCommands: true },
        durable_dashboard: {
          apps: { shop: { store: new InMemoryStateStore(), controlPlane } },
        },
      }),
    );
    expect(results).toMatchObject([
      { status: 'error', fix: expect.stringMatching(/@adonis-agora\/crypto/) },
      { status: 'error', fix: expect.stringMatching(/apps\.shop\.actions: false/) },
    ]);
  });

  it('reports the resolved mode of each side', async () => {
    const server = new FakeCryptoServer();
    const results = await checkConsoleCommands(
      fakeApp(
        {
          durable: { consoleCommands: { actions: true } },
          durable_dashboard: {
            apps: { shop: { store: new InMemoryStateStore(), controlPlane } },
          },
        },
        { 'agora.crypto': server.runtime('hub', { embedded: true }) },
      ),
    );
    expect(results).toEqual([
      { status: 'ok', message: 'App side: crypto (auto, key console-durable); actions on.' },
      {
        status: 'ok',
        message: 'Console side, app "shop": crypto (auto, key console-durable, partition shop).',
      },
    ]);
  });

  it('§13e: with crypto the token key is not published, and the doctor says crypto is enough', async () => {
    const server = new FakeCryptoServer();
    const results = await checkConsoleCommands(
      fakeApp(
        {
          'app.appKey': 'harm13-doctor-app-key-0123456789abcdef',
          durable: { consoleCommands: { actions: true } },
        },
        {
          'agora.crypto': server.runtime('shop', { embedded: true }),
          'authkit.client': new FakeAuthkit('shop'),
        },
      ),
    );
    expect(results).toContainEqual({
      status: 'ok',
      message:
        "console commands: this app's token key is not published: crypto is enough to reach it.",
    });
  });

  it('deep: the key exists and this process seals and opens with it', async () => {
    const server = new FakeCryptoServer();
    const app = fakeApp(
      {
        durable: { consoleCommands: true },
        durable_dashboard: {
          apps: { shop: { store: new InMemoryStateStore(), controlPlane } },
        },
      },
      { 'agora.crypto': server.runtime('hub', { embedded: true }) },
    );
    // Not created yet: a warning (it is created at the first command), never by the doctor.
    expect((await checkConsoleCommandsCrypto(app)).map((r) => r.status)).toEqual(['warn', 'warn']);
    expect(server.hasKey('hub', 'console-durable')).toBe(false);
    server.createKeyIn('hub', 'console-durable');
    server.createKeyIn('shop', 'console-durable');
    expect((await checkConsoleCommandsCrypto(app)).map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('deep: a console that is a crypto tenant without crypto:seal is an error saying so', async () => {
    const server = new FakeCryptoServer();
    server.createKeyIn('shop', 'console-durable');
    const results = await checkConsoleCommandsCrypto(
      fakeApp(
        {
          durable_dashboard: {
            apps: { shop: { store: new InMemoryStateStore(), controlPlane } },
          },
        },
        { 'agora.crypto': server.runtime('hub', { grants: [] }) },
      ),
    );
    expect(results).toMatchObject([
      { status: 'error', fix: expect.stringMatching(/crypto:seal:console-\*/) },
    ]);
  });

  it('deep: a crypto tenant whose key does not exist yet is ok, with a note (the server provisions it)', async () => {
    const server = new FakeCryptoServer();
    const results = await checkConsoleCommandsCrypto(
      fakeApp({ durable: { consoleCommands: true } }, { 'agora.crypto': server.runtime('shop') }),
    );
    expect(results).toEqual([
      {
        status: 'ok',
        message: expect.stringMatching(
          /^App side: the crypto key "console-durable" does not exist in partition shop yet; the crypto server creates it on the console's first command/,
        ),
      },
    ]);
  });

  it('deep: a refused crypto tenant is an error that asks for no grant', async () => {
    const server = new FakeCryptoServer();
    const results = await checkConsoleCommandsCrypto(
      fakeApp(
        { durable: { consoleCommands: true } },
        { 'agora.crypto': server.runtime('shop', { refuse: true }) },
      ),
    );
    expect(results).toMatchObject([{ status: 'error', fix: expect.stringMatching(/no grant/) }]);
    expect(results[0]?.fix).not.toMatch(/crypto:decrypt/);
  });
});

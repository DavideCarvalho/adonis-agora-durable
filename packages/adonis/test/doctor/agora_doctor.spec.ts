import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGORA_DOCTOR_BINDING,
  type AgoraDoctorCheck,
  AgoraDoctorUsageError,
  discoverDoctorChecks,
  readDoctorChecks,
  registerDoctorChecks,
  renderAgoraDoctor,
  runAgoraDoctor,
  satisfies,
} from '../../src/doctor/agora_doctor.js';
import {
  checkConfig,
  checkConsoleGate,
  checkCronParser,
  checkTenantToken,
  checkVerifyTenant,
} from '../../src/doctor/checks.js';

/** A fixture app root with node_modules/<name>/package.json entries. */
async function fixtureApp(
  root: string,
  packages: Record<string, Record<string, unknown>>,
  deps: Record<string, string> = {},
): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }));
  for (const [name, manifest] of Object.entries(packages)) {
    const dir = join(root, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
  }
}

function fakeApp(root: string, over: Partial<ApplicationService> = {}): ApplicationService {
  return {
    inProduction: false,
    nodeEnvironment: 'development',
    makePath: (...parts: string[]) => join(root, ...parts),
    config: { get: (_key: string, fallback: unknown) => fallback },
    ...over,
  } as unknown as ApplicationService;
}

function fakeContainer() {
  const values = new Map<string, unknown>();
  return {
    values,
    hasBinding: (key: string) => values.has(key),
    bindValue: (key: string, value: unknown) => void values.set(key, value),
    make: async (key: string) => values.get(key),
  };
}

const check = (
  over: Partial<AgoraDoctorCheck> & { id: string; lib: string },
): AgoraDoctorCheck => ({
  title: over.id,
  run: () => ({ status: 'ok', message: 'fine' }),
  ...over,
});

describe('registerDoctorChecks', () => {
  it('creates, reuses, skips duplicates and other versions', async () => {
    const container = fakeContainer();
    await registerDoctorChecks(container, [check({ id: 'a.one', lib: 'a' })]);
    await registerDoctorChecks(container, [
      check({ id: 'a.one', lib: 'a' }),
      check({ id: 'b.one', lib: 'b' }),
    ]);
    expect((await readDoctorChecks(container)).map((c) => c.id)).toEqual(['a.one', 'b.one']);

    const other = fakeContainer();
    other.bindValue(AGORA_DOCTOR_BINDING, { version: 2, checks: [] });
    await registerDoctorChecks(other, [check({ id: 'a.one', lib: 'a' })]);
    await expect(readDoctorChecks(other)).rejects.toBeInstanceOf(AgoraDoctorUsageError);
  });
});

describe('satisfies', () => {
  it.each([
    ['1.2.3', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.6.2', '^0.6.0 || ^0.7.0', true],
    ['0.8.0', '^0.6.0 || ^0.7.0', false],
    ['1.0.0-rc.3', '>=1.0.0 <2.0.0 || >=1.0.0-rc.1 <2.0.0', true],
    ['1.0.0-rc.0', '>=1.0.0-rc.1 <2.0.0', false],
    ['11.0.0', '^9.2.0 || ^10.0.0 || ^11.0.0', true],
    ['5.1.0', '>= 5', true],
    ['4.9.9', '~4.9.0', true],
    ['4.10.0', '~4.9.0', false],
    ['3.0.0', '*', true],
  ])('%s in %s → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });
});

describe('runAgoraDoctor', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agora-doctor-'));
    await fixtureApp(
      root,
      {
        '@adonis-agora/durable': {
          version: '1.0.0-rc.12',
          peerDependencies: { '@adonisjs/core': '^7.3.0', cron: '^5.0.0' },
          peerDependenciesMeta: { cron: { optional: true } },
        },
        '@adonis-agora/payments': { version: '0.9.0' },
        '@adonisjs/core': { version: '7.6.0' },
      },
      { '@adonis-agora/durable': '*', '@adonis-agora/payments': '*' },
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('adds the built-in checks, orders by lib then registration, and summarizes', async () => {
    const { report, exitCode } = await runAgoraDoctor(fakeApp(root), [
      check({ id: 'payments.x', lib: 'payments' }),
      check({ id: 'durable.b', lib: 'durable', run: () => ({ status: 'warn', message: 'meh' }) }),
      check({ id: 'durable.a', lib: 'durable' }),
    ]);
    expect(report.results.map((r) => r.id)).toEqual([
      'durable.registered',
      'durable.peers',
      'durable.peers',
      'durable.agora-siblings',
      'durable.b',
      'durable.a',
      'payments.registered',
      'payments.peers',
      'payments.agora-siblings',
      'payments.x',
    ]);
    const peers = report.results.filter((r) => r.id === 'durable.peers');
    expect(peers.map((r) => r.status)).toEqual(['skip', 'ok']);
    const siblings = report.results.find((r) => r.id === 'durable.agora-siblings');
    expect(siblings?.status).toBe('warn');
    expect(siblings?.message).toContain('@adonis-agora/payments 0.9.0');
    expect(report.libs).toEqual([
      { lib: 'durable', package: '@adonis-agora/durable', version: '1.0.0-rc.12' },
      { lib: 'payments', package: '@adonis-agora/payments', version: '0.9.0' },
    ]);
    expect(report.summary).toEqual({ ok: 6, warn: 3, error: 0, skip: 1 });
    expect(exitCode).toBe(0);
  });

  it('a missing required peer and an out-of-range one are errors (exit 1)', async () => {
    await fixtureApp(
      root,
      {
        '@adonis-agora/durable': {
          version: '1.0.0',
          peerDependencies: { '@adonisjs/core': '^8.0.0', '@adonisjs/lucid': '^22.0.0' },
        },
        '@adonisjs/core': { version: '7.6.0' },
      },
      { '@adonis-agora/durable': '*' },
    );
    const { report, exitCode } = await runAgoraDoctor(fakeApp(root), [
      check({ id: 'durable.a', lib: 'durable' }),
    ]);
    const peers = report.results.filter((r) => r.id === 'durable.peers');
    expect(peers.map((r) => r.status)).toEqual(['error', 'error']);
    expect(exitCode).toBe(1);
  });

  it('filters by lib, only and deep; unknown --only is a usage error', async () => {
    const checks = [
      check({ id: 'durable.a', lib: 'durable' }),
      check({ id: 'durable.deep', lib: 'durable', cost: 'deep' }),
      check({ id: 'payments.x', lib: 'payments' }),
    ];
    const byLib = await runAgoraDoctor(fakeApp(root), checks, { libs: ['payments'] });
    expect(new Set(byLib.report.results.map((r) => r.lib))).toEqual(new Set(['payments']));
    expect(
      (await runAgoraDoctor(fakeApp(root), checks)).report.results.some(
        (r) => r.id === 'durable.deep',
      ),
    ).toBe(false);
    expect(
      (await runAgoraDoctor(fakeApp(root), checks, { deep: true })).report.results.some(
        (r) => r.id === 'durable.deep',
      ),
    ).toBe(true);
    const only = await runAgoraDoctor(fakeApp(root), checks, { only: 'durable.a' });
    expect(only.report.results.map((r) => r.id)).toEqual(['durable.a']);
    await expect(runAgoraDoctor(fakeApp(root), checks, { only: 'nope' })).rejects.toBeInstanceOf(
      AgoraDoctorUsageError,
    );
  });

  it('a throw or a timeout is an error; warnings fail only with strict', async () => {
    const { report } = await runAgoraDoctor(
      fakeApp(root),
      [
        check({
          id: 'durable.throws',
          lib: 'durable',
          run: () => {
            throw new Error('boom');
          },
        }),
        check({ id: 'durable.slow', lib: 'durable', run: () => new Promise(() => undefined) }),
      ],
      { timeoutMs: 20 },
    );
    expect(report.results.find((r) => r.id === 'durable.throws')).toMatchObject({
      status: 'error',
      message: 'boom',
    });
    expect(report.results.find((r) => r.id === 'durable.slow')).toMatchObject({
      status: 'error',
      message: 'timed out after 0.02s',
    });
    const warnOnly = [
      check({ id: 'durable.w', lib: 'durable', run: () => ({ status: 'warn', message: 'w' }) }),
    ];
    expect((await runAgoraDoctor(fakeApp(root), warnOnly, { libs: ['durable'] })).exitCode).toBe(0);
    expect(
      (await runAgoraDoctor(fakeApp(root), warnOnly, { libs: ['durable'], strict: true })).exitCode,
    ).toBe(1);
  });

  it('renders plain text without symbols, hides skips unless verbose', async () => {
    const { report } = await runAgoraDoctor(fakeApp(root), [
      check({
        id: 'durable.bad',
        lib: 'durable',
        title: 'Bad thing',
        run: () => ({ status: 'error', message: 'it broke', fix: 'fix it' }),
      }),
    ]);
    const text = renderAgoraDoctor(report);
    expect(text).toContain('@adonis-agora doctor · development · 1 lib ·');
    expect(text).toContain('  error Bad thing\n    it broke\n    fix: fix it');
    expect(text).not.toContain('✖');
    expect(text).toContain('(skipped 1, run with --verbose)');
    expect(renderAgoraDoctor(report, { verbose: true })).toContain('optional peer cron');
    expect(renderAgoraDoctor(report, { fancy: true })).toContain('✖ Bad thing');
  });

  it('discovers ./doctor entries of installed agora packages (--no-boot)', async () => {
    const dir = join(root, 'node_modules', '@adonis-agora', 'durable');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@adonis-agora/durable',
        version: '1.0.0',
        exports: { './doctor': { import: './doctor.js' } },
      }),
    );
    await writeFile(
      join(dir, 'doctor.js'),
      "export const agoraDoctorChecks = [{ id: 'durable.x', lib: 'durable', title: 'x', run: () => ({ status: 'ok', message: 'x' }) }]\n",
    );
    const found = await discoverDoctorChecks(fakeApp(root));
    expect(found.map((c) => c.id)).toEqual(['durable.x']);
  });
});

describe('durable checks', () => {
  it('config', () => {
    expect(checkConfig(undefined).status).toBe('warn');
    expect(checkConfig({ role: 'tenant' } as never)).toMatchObject({ status: 'error' });
    expect(checkConfig({ topology: 'cluster' } as never)).toMatchObject({ status: 'error' });
    expect(checkConfig({ store: 'lucid', stores: {} } as never)).toMatchObject({ status: 'error' });
    expect(checkConfig({ transport: 'q', transports: {} } as never)).toMatchObject({
      status: 'error',
    });
    expect(checkConfig({}).status).toBe('ok');
  });

  it('verify-tenant: warn in dev, error in production, skip elsewhere', () => {
    expect(checkVerifyTenant({}, true).status).toBe('skip');
    expect(checkVerifyTenant({ topology: 'control-plane' } as never, false).status).toBe('warn');
    expect(checkVerifyTenant({ topology: 'control-plane' } as never, true).status).toBe('error');
    expect(
      checkVerifyTenant({ topology: 'control-plane', verifyTenant: () => null } as never, true)
        .status,
    ).toBe('ok');
  });

  it('tenant-token', () => {
    expect(checkTenantToken({}).status).toBe('skip');
    expect(checkTenantToken({ topology: 'tenant' } as never).status).toBe('error');
    expect(checkTenantToken({ topology: 'tenant', tenant: { token: 't' } } as never).status).toBe(
      'ok',
    );
    expect(
      checkTenantToken({ topology: 'tenant', tenant: { token: () => 't' } } as never).status,
    ).toBe('ok');
  });

  it('cron-parser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agora-doctor-cron-'));
    try {
      const cron = { schedules: [{ key: 'k', workflow: 'w', cron: '* * * * *' }] } as never;
      expect((await checkCronParser({}, root)).status).toBe('skip');
      await fixtureApp(root, {});
      expect((await checkCronParser(cron, root)).status).toBe('error');
      await fixtureApp(root, { 'cron-parser': { version: '4.9.0' } });
      expect((await checkCronParser(cron, root)).status).toBe('ok');
      await fixtureApp(root, { 'cron-parser': { version: '3.5.0' } });
      expect((await checkCronParser(cron, root)).status).toBe('error');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('console gate', () => {
    expect(checkConsoleGate(undefined, true).status).toBe('skip');
    expect(checkConsoleGate({ enabled: false }, true).status).toBe('skip');
    expect(checkConsoleGate({}, false).status).toBe('warn');
    expect(checkConsoleGate({}, true).status).toBe('error');
    expect(checkConsoleGate({ authorize: () => true }, true).status).toBe('ok');
  });
});

describe('agora:doctor command', () => {
  let appRoot: string;
  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'agora-doctor-ace-'));
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
    await fixtureApp(
      appRoot,
      { '@adonis-agora/durable': { version: '1.0.0' } },
      { '@adonis-agora/durable': '*' },
    );
  });
  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  async function exec(argv: string[], checks: AgoraDoctorCheck[]) {
    const ace = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await ace.app.init();
    await ace.app.boot();
    await registerDoctorChecks(ace.app.container, checks);
    const { default: AgoraDoctor } = await import('../../commands/agora_doctor.js');
    ace.ui.switchMode('raw');
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const command = await ace.create(AgoraDoctor, argv);
      await command.exec();
      return { exitCode: command.exitCode, stdout: out.join('') };
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('--json prints one report object and exits 1 on an error', async () => {
    const { exitCode, stdout } = await exec(
      ['--json'],
      [
        check({
          id: 'durable.bad',
          lib: 'durable',
          run: () => ({ status: 'error', message: 'x' }),
        }),
      ],
    );
    const report = JSON.parse(stdout);
    expect(report.version).toBe(1);
    expect(report.summary.error).toBe(1);
    expect(exitCode).toBe(1);
  });

  it('exits 0 with only warnings, 1 with --strict, 2 for an unknown --only', async () => {
    const warn = [
      check({ id: 'durable.w', lib: 'durable', run: () => ({ status: 'warn', message: 'w' }) }),
    ];
    expect((await exec([], warn)).exitCode).toBe(0);
    expect((await exec(['--strict'], warn)).exitCode).toBe(1);
    expect((await exec(['--only=nope'], warn)).exitCode).toBe(2);
  });

  it('durable:doctor pre-filters durable', async () => {
    const ace = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    const { default: DurableDoctor } = await import('../../commands/durable_doctor.js');
    expect(DurableDoctor.commandName).toBe('durable:doctor');
    expect(ace).toBeDefined();
  });
});

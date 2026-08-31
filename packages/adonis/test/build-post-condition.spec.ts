import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Guards the `build` post-condition, which exists because `pnpm build` could exit 0 having
 *  emitted no JavaScript: `tsc` with `incremental: true` treats its buildinfo as the record of
 *  what is on disk, so deleting `dist/` and leaving the buildinfo made it emit nothing. Turbo then
 *  cached the empty `dist/` and replayed it as a success.
 *
 *  What this spec deliberately does NOT do: shell out to `tsc`. Reproducing the original defect
 *  end to end means a ~10s full build per case, and durable plan 011 is the story of what happens
 *  to specs like that — they become `it.skip`. So this covers the two halves that are cheap and
 *  still load-bearing: the guard script's own exit codes (milliseconds, no compiler), and the fact
 *  that the `build` script actually invokes it. The end-to-end proof lives in plan 012's step 3
 *  and in the guard being on the real build path, not in a test that would rot. */
describe('build post-condition', () => {
  const scriptPath = fileURLToPath(
    new URL('../../../scripts/assert-build-output.mjs', import.meta.url),
  );

  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'durable-build-postcondition-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function runGuard(...args: string[]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: workDir,
      encoding: 'utf8',
    });
    return { status: result.status, stderr: result.stderr ?? '' };
  }

  it('passes when dist has JavaScript and the required entrypoint', () => {
    mkdirSync(join(workDir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(workDir, 'dist', 'src', 'index.js'), 'export const ok = true;\n');

    expect(runGuard('dist', 'src/index.js').status).toBe(0);
  });

  it('fails when dist exists but holds no JavaScript — the exact shape of the cached empty build', () => {
    // What the defect produced: `copy:stubs` is a plain `cp`, so it ran even when `tsc` emitted
    // nothing, leaving a dist/ that looks built and contains no code.
    mkdirSync(join(workDir, 'dist', 'stubs'), { recursive: true });
    mkdirSync(join(workDir, 'dist', 'assets', 'spa'), { recursive: true });
    writeFileSync(join(workDir, 'dist', 'assets', 'spa', 'index.html'), '<html></html>');

    const { status, stderr } = runGuard('dist', 'src/index.js');

    expect(status).toBe(1);
    expect(stderr).toContain('no JavaScript');
    expect(stderr).toContain('How to recover');
  });

  it('fails when dist does not exist at all', () => {
    const { status, stderr } = runGuard('dist', 'src/index.js');

    expect(status).toBe(1);
    expect(stderr).toContain('does not exist');
  });

  it('fails when JavaScript was emitted but the package entrypoint is missing', () => {
    mkdirSync(join(workDir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(workDir, 'dist', 'src', 'something-else.js'), 'export const ok = true;\n');

    const { status, stderr } = runGuard('dist', 'src/index.js');

    expect(status).toBe(1);
    expect(stderr).toContain('src/index.js');
  });

  it('names a recovery command that actually removes the stale state it points at', () => {
    // The buildinfo files are dotfiles. A bare `*.tsbuildinfo` in the hint would not match them,
    // so following the advice would leave the tree exactly as broken as before.
    const { stderr } = runGuard('dist', 'src/index.js');

    expect(stderr).toContain('.*tsbuildinfo');
  });

  it('is wired into the build script, ahead of nothing and behind the compile', () => {
    // Without this, the guard is a file nobody runs. Asserting on the script text is shallow but it
    // is the one thing that catches the guard being quietly dropped from the pipeline.
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts.build).toContain('check:dist');
    expect(pkg.scripts['check:dist']).toContain('assert-build-output.mjs');

    // `clean` must precede the compile: removing dist/ up front is what stops stale incremental
    // state from existing in the first place. And the compile must use the non-incremental config,
    // so build keeps no buildinfo that could disagree with dist/ or race typecheck's.
    const build = pkg.scripts.build!; // asserted present above
    expect(build.indexOf('clean')).toBeLessThan(build.indexOf('tsc'));
    expect(build).toContain('tsconfig.build.json');
  });
});

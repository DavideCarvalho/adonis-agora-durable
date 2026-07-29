/**
 * Diagnostic preflight for the vitest suite, NOT a test.
 *
 * `better-sqlite3` (a devDependency used only by the Lucid-store test harness) ships a prebuilt
 * native binary tied to a specific Node ABI (`NODE_MODULE_VERSION`). When the running Node doesn't
 * match the binary it was built for, the import throws deep inside the native loader with a
 * message that says nothing about Node versions or ABI mismatches — and because every Lucid-store
 * spec then fails independently in its own teardown, the developer sees a wall of unrelated
 * failures instead of the one real cause. That has already cost a full debugging session on this
 * project (271 failures in adonis-authkit, ~77 here, all from one ABI mismatch).
 *
 * This runs once, in vitest's main process, before any test file, via `globalSetup`
 * (see vitest.config.ts). If the driver can't load, it throws — vitest surfaces a thrown
 * `globalSetup` error as a single clean run-level failure. It deliberately does NOT
 * `process.exit(1)`: an abrupt exit can truncate reporter output, which would defeat the point of
 * making the failure legible.
 *
 * This is a mitigation, not a fix — the native-binding fragility remains. See plan
 * 009-sqlite-preflight.md for the two alternatives (`node:sqlite`, `libsql`) that were
 * investigated and rejected.
 */
export default async function globalSetup(): Promise<void> {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('select 1').get();
    db.close();
  } catch (error) {
    throw new Error(
      [
        '',
        'sqlite driver failed to load — this usually means `better-sqlite3` was',
        'built for a different Node ABI. Run `nvm use` (see `.nvmrc`) then',
        '`pnpm rebuild better-sqlite3`.',
        '',
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
        '',
      ].join('\n'),
    );
  }
}

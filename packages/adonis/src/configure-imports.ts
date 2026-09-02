/**
 * The Node subpath imports the generated barrels resolve through.
 *
 * The barrels the assembler hooks emit import each module by alias — `#workflows/foo_workflow` —
 * exactly like `@adonisjs/core`'s controllers barrel uses `#controllers/*`. The difference is that
 * `#controllers/*` ships in the app skeleton and `#workflows/*` does not, so without `configure`
 * writing them the generated barrel names a specifier Node cannot resolve and the app dies at boot
 * with `ERR_PACKAGE_IMPORT_NOT_DEFINED` — after a build that reported success.
 *
 * Keys and targets are kept in lockstep with the hooks' `importAlias` / `source` defaults; the spec
 * asserts that pairing so changing one without the other fails loudly instead of at a consumer's
 * boot.
 */
export const DURABLE_SUBPATH_IMPORTS: Readonly<Record<string, string>> = {
  '#workflows/*': './app/workflows/*.js',
  '#steps/*': './app/steps/*.js',
};

/**
 * Merge {@link DURABLE_SUBPATH_IMPORTS} into an app's `package.json` `imports` map.
 *
 * Never overwrites an entry the app already defines — an app that points `#workflows/*` somewhere
 * else made that choice deliberately, and `configure` is not the place to overrule it. Returns the
 * merged map plus the keys actually added, so the caller can skip the write (and the log line) when
 * there is nothing to do, making a re-run of `configure` a no-op.
 */
export function mergeSubpathImports(existing: Record<string, string> | undefined): {
  imports: Record<string, string>;
  added: string[];
} {
  const imports = { ...(existing ?? {}) };
  const added: string[] = [];

  for (const [key, target] of Object.entries(DURABLE_SUBPATH_IMPORTS)) {
    if (key in imports) continue;
    imports[key] = target;
    added.push(key);
  }

  return { imports, added };
}

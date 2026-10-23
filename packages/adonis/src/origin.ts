import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Derives a workflow's **origin** — the npm package that declared it (`@adonis-agora/catalog-pipeline`,
 * the host app's own `package.json` `name`, …) — so every run says which package's code produced it
 * (see {@link import('./interfaces.js').WorkflowRun.origin}) without the workflow opting into anything.
 *
 * WHY IT IS DERIVED AND NOT DECLARED: anything a lib has to opt into (`static workflow = { origin }`,
 * a registry of known packages) is already wrong in the field the day a lib forgets, and an origin
 * facet that lists two of the five libs actually running is worse than none. So the inputs are ones a
 * workflow cannot fail to provide — a FILE that belongs to the declaring package — mapped to the
 * nearest enclosing `package.json` `name`. In order of precision:
 *
 *   1. **The class's declaring file**, captured by a class decorator (`@Scheduled`, `@OnEvent`,
 *      `@OnDiagnostic`) at decoration time — the one moment we are guaranteed to be executing inside
 *      the declaring module. Exact, but only present on decorated classes.
 *   2. **The discovered module's file**: the `app/workflows` scan knows the absolute path of every
 *      module it imports, and a multi-root generated barrel keys each module by its app-relative path.
 *      A single-root barrel keys modules by name only, so its modules resolve from the app root the
 *      barrel was generated for (its sources are the app's own directories by construction).
 *   3. **The registering caller's file**: `registerWorkflowClass(engine, Cls)` /
 *      `engine.register(name, …)` called by a lib attribute to that lib, because the first stack frame
 *      above the call is the lib's own code. This is the weakest signal: an APP that hand-registers a
 *      lib's class is credited with it — such a class should carry an explicit `origin` (or one of the
 *      decorators above).
 *
 * An explicit `origin` (the class's `static workflow.origin`, or `engine.register`'s `origin` option)
 * always wins over every derived signal.
 *
 * EVERY step can fail, and each failure yields `undefined` (= unknown) rather than a guess:
 *   - a runtime without V8's `Error.captureStackTrace`, or an app that set `Error.stackTraceLimit = 0`
 *   - a frame that is not a real file (`node:` internals, `eval`, `<anonymous>`, a bundler virtual id)
 *     — a single-file bundle can also collapse several packages into one REAL file, in which case the
 *     origin is the bundle's package: that is the one shape this cannot detect
 *   - no `package.json` carrying a `name` anywhere above the file
 * The durable provider reports the workflows that came back unattributed once, at boot.
 *
 * Built output and package managers: an Adonis `build/` directory carries its own copy of the app's
 * `package.json`, so `build/app/workflows/x.js` resolves to the app's name; a pnpm install resolves
 * `node_modules/.pnpm/<pkg>@<v>/node_modules/@scope/pkg/dist/x.js` to `@scope/pkg` (the nearest
 * NAMED `package.json` — a nameless `{ "type": "module" }` marker in `dist/` is walked past).
 */

/** The file each decorated class was declared in, keyed by the class itself. */
const declaringFileByClass = new WeakMap<object, string>();

/** Memoized directory → owning package name (or `undefined` when the walk found none). */
const packageNameByDir = new Map<string, string | undefined>();

type AnyFunction = (...args: never[]) => unknown;

/**
 * Marks an `engine.register` call whose origin was ALREADY resolved by the caller (the class /
 * discovery paths), so the engine does not derive one from its own caller — which would be this
 * package's discovery code, not the workflow's. Internal: not exported from the package entry.
 */
export const ORIGIN_RESOLVED: unique symbol = Symbol('durable.originResolved');

/**
 * The absolute path of the file that is calling `boundary` right now. `boundary` is clipped off the
 * captured stack (`Error.captureStackTrace`'s second argument), so the first remaining frame is its
 * caller's, with no frame counting to go stale when this file is refactored. Must be called
 * synchronously from inside `boundary` (before any `await`). `undefined` on any runtime that does not
 * give a usable frame.
 */
export function callerFile(boundary: AnyFunction): string | undefined {
  try {
    const capture = Error.captureStackTrace;
    if (typeof capture !== 'function') return undefined;
    const holder: { stack?: string } = {};
    capture(holder, boundary);
    return topFrameFile(holder.stack);
  } catch {
    return undefined;
  }
}

/** The package whose code is calling `boundary` right now (see {@link callerFile}), else `undefined`. */
export function originOfCaller(boundary: AnyFunction): string | undefined {
  const file = callerFile(boundary);
  return file === undefined ? undefined : originOfFile(file);
}

/** Records the file `target` was declared in, so {@link declaredOriginOf} can resolve it later. */
export function rememberDeclaringFile(target: unknown, file: string | undefined): void {
  if (file && typeof target === 'function') declaringFileByClass.set(target, file);
}

/**
 * The package that declared `target` per its decoration-time declaring file, or `undefined` when no
 * decorator captured one (or it cannot be resolved). Walks the constructor chain: a subclass inherits
 * its base's `static` workflow config and schedules, so it inherits the base's declaring file too.
 */
export function declaredOriginOf(target: unknown): string | undefined {
  for (let ctor: unknown = target; typeof ctor === 'function'; ctor = Object.getPrototypeOf(ctor)) {
    const file = declaringFileByClass.get(ctor);
    if (file) return originOfFile(file);
  }
  return undefined;
}

/**
 * The `name` of the nearest `package.json` at or above `file`'s directory. The file itself need not
 * exist (a barrel's `.ts` key in a built app): only the directories above it are read. Memoized per
 * directory — the walk hits the filesystem once per distinct directory, not once per workflow.
 */
export function originOfFile(file: string): string | undefined {
  try {
    return originOfDir(dirname(resolve(file)));
  } catch {
    return undefined;
  }
}

/** The `name` of the nearest `package.json` at or above `dir` (see {@link originOfFile}). */
export function originOfDir(start: string): string | undefined {
  try {
    const visited: string[] = [];
    let dir = resolve(start);
    for (;;) {
      if (packageNameByDir.has(dir)) {
        const cached = packageNameByDir.get(dir);
        for (const seen of visited) packageNameByDir.set(seen, cached);
        return cached;
      }
      visited.push(dir);
      const name = readPackageName(join(dir, 'package.json'));
      if (name !== undefined) {
        for (const seen of visited) packageNameByDir.set(seen, name);
        return name;
      }
      const parent = dirname(dir);
      // `dirname('/')` is `'/'` — the filesystem root is the end of the walk.
      if (parent === dir) {
        for (const seen of visited) packageNameByDir.set(seen, undefined);
        return undefined;
      }
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/** The `name` field of a `package.json`, or `undefined` if it is missing, unreadable or unnamed. */
function readPackageName(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed package.json is not ours to fail on — keep walking up.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const name = (parsed as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * The file named by the FIRST frame of a captured stack. Deliberately only the first: with the
 * capture boundary clipped, frame 0 IS the calling site, and falling through to a deeper frame when
 * it is unparseable would attribute the workflow to whatever happened to be further up the stack
 * (the test runner, the Adonis loader) — a confident-looking wrong answer.
 */
function topFrameFile(stack: string | undefined): string | undefined {
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('at ')) continue;
    return fileOfFrame(frame.slice(3));
  }
  return undefined;
}

/** `foo (/a/b.ts:1:2)` / `/a/b.ts:1:2` / `file:///a/b.js:1:2` → an absolute path, else `undefined`. */
function fileOfFrame(frame: string): string | undefined {
  const match = /\((.+):\d+:\d+\)$/.exec(frame) ?? /^(.+):\d+:\d+$/.exec(frame);
  const location = match?.[1];
  if (location === undefined) return undefined;
  if (location.startsWith('file://')) {
    try {
      return fileURLToPath(location);
    } catch {
      return undefined;
    }
  }
  // Anything that is not an absolute path is not a file we can resolve a package from:
  // `node:internal/…`, `<anonymous>`, `eval at …`, a bundler's virtual id.
  const absolute = location.startsWith('/') || /^[A-Za-z]:[\\/]/.test(location);
  return absolute ? location : undefined;
}

// Module hooks that let a plain `node` child process import this package's TypeScript sources
// directly, the way vitest does: `./x.js` specifiers resolve to the sibling `x.ts`, and `.ts` files
// outside node_modules are compiled with SWC (decorators included). Registered by `register-ts.mjs`.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import swc from '@swc/core';

export async function resolve(specifier, context, next) {
  if (
    specifier.endsWith('.js') &&
    (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) &&
    context.parentURL?.startsWith('file:') &&
    !context.parentURL.includes('/node_modules/')
  ) {
    const asTs = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, '.ts');
    if (existsSync(asTs)) return { url: pathToFileURL(asTs).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/')) {
    const filename = fileURLToPath(url);
    const { code } = await swc.transform(await readFile(filename, 'utf8'), {
      filename,
      sourceMaps: 'inline',
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true },
      },
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return next(url, context);
}

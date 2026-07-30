import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * Teste de regressao para o bug do subpath `/testing`: importar QUALQUER coisa dele carregava,
 * via barrel, os dois geradores de suite de conformance -- e esses importam `vitest`
 * incondicionalmente. Resultado: um app sem vitest (ex.: Japa) nao conseguia nem importar
 * `createTestEngine`, apesar de `vitest` ser peer dependency OPCIONAL no package.json.
 *
 * Um teste que so faz `import('@adonis-agora/durable/testing')` dentro do proprio vitest do
 * repo passaria mesmo com o bug presente: o vitest do runner ja esta em node_modules, entao a
 * resolucao "funciona" independente do bug. Isso seria um teste vazio (verde tanto com quanto
 * sem o fix). Em vez disso, caminhamos o grafo estatico de imports a partir de cada entry point
 * -- sem executar nada -- e verificamos se `vitest` e alcancavel. Essa checagem falha ANTES do
 * fix (o barrel de `/testing` reexporta os dois arquivos de conformance) e passa DEPOIS (esses
 * arquivos saem do barrel principal e passam a viver so no subpath dedicado `/testing/conformance`).
 */

/** Extrai os especificadores de todo `import`/`export ... from '...'` e `import '...'` de um arquivo. */
function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromClause = /\bfrom\s+['"]([^'"]+)['"]/g;
  const sideEffectImport = /^\s*import\s+['"]([^'"]+)['"]/gm;
  for (const re of [fromClause, sideEffectImport]) {
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: laco padrao de RegExp#exec
    while ((match = re.exec(source))) specifiers.push(match[1]!);
  }
  return specifiers;
}

/** Resolve um especificador relativo (estilo NodeNext, com sufixo `.js`) para o arquivo `.ts` fonte. */
function resolveRelative(fromFile: string, specifier: string): string {
  const candidate = resolve(dirname(fromFile), specifier);
  const asTs = candidate.endsWith('.js') ? `${candidate.slice(0, -3)}.ts` : candidate;
  try {
    readFileSync(asTs);
    return asTs;
  } catch {
    return join(candidate, 'index.ts');
  }
}

/**
 * Caminha o grafo de imports a partir de `entry` (seguindo apenas especificadores relativos) e
 * devolve o conjunto de especificadores "bare" (pacotes de node_modules) alcancados -- sem
 * executar nenhum modulo, so lendo texto e recursando.
 */
function reachableBareSpecifiers(entry: string): Set<string> {
  const visited = new Set<string>();
  const bare = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        pending.push(resolveRelative(file, specifier));
      } else {
        bare.add(specifier);
      }
    }
  }
  return bare;
}

describe('subpath /testing e importavel sem vitest', () => {
  it('o grafo de imports do barrel de testing-kit nunca alcanca "vitest"', () => {
    const entry = resolve(SRC, 'testing-kit/index.ts');
    const bare = reachableBareSpecifiers(entry);
    expect(bare.has('vitest')).toBe(false);
  });

  it('sanity check: o entry point dedicado de conformance ainda alcanca "vitest"', () => {
    const entry = resolve(SRC, 'testing-kit/conformance.ts');
    const bare = reachableBareSpecifiers(entry);
    expect(bare.has('vitest')).toBe(true);
  });
});

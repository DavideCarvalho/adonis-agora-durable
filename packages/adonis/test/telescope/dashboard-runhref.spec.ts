import { describe, expect, it } from 'vitest';
import { durableDashboard } from '../../src/telescope/dashboard.js';

/** Todo `link.href` que o spec do dashboard declara. */
function hrefs(spec: ReturnType<typeof durableDashboard>): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;
    const link = record.link as { href?: unknown } | undefined;
    if (link && typeof link.href === 'string') found.push(link.href);
    for (const value of Object.values(record)) walk(value);
  };
  walk(spec as unknown);
  return found;
}

/**
 * O link "abrir este run" do dashboard do telescope estava morto em produção: dava
 * 404 em `/durable/runs/<id>`.
 *
 * O console é um SPA roteado por HASH — `App.tsx` casa
 * `window.location.hash` contra `/^#\/run\/(.+)$/` — então um caminho comum nunca
 * chega nele: quem responde é o router do app, com 404. E o default ainda estava no
 * plural ("runs") contra o singular que o SPA espera.
 */
describe('durableDashboard — runHref', () => {
  it('o default é hash e no singular', () => {
    const links = hrefs(durableDashboard());
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      expect(href).toContain('#/run/');
      // O erro antigo, explicitamente: caminho comum, no plural.
      expect(href).not.toContain('/durable/runs/');
    }
  });

  it('carrega o placeholder do run id', () => {
    expect(hrefs(durableDashboard())[0]).toContain('{runId}');
  });

  it('quem monta o console em outro path passa o seu', () => {
    // O template precisa carregar o mount path, e este módulo não tem como sabê-lo.
    const links = hrefs(durableDashboard({ runHref: '/admin/durable#/run/{runId}' }));
    expect(links[0]).toBe('/admin/durable#/run/{runId}');
  });
});

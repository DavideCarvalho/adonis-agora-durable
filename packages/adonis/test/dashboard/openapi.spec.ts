import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../../src/dashboard/openapi.js';

describe('the dashboard OpenAPI document', () => {
  it('is a valid-shaped 3.1 document rooted at the api base', () => {
    const doc = openApiDocument('/durable/api') as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0]?.url).toBe('/durable/api');
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(20);
  });

  it('documents every route the provider registers (drift guard)', () => {
    const doc = openApiDocument('/durable/api') as { paths: Record<string, unknown> };
    // The provider's route table, spelled as OpenAPI paths. Adding a route without documenting it
    // here fails this list; removing one leaves a stale entry to delete.
    const expected = [
      '/runs',
      '/runs/values',
      '/runs/{id}',
      '/runs/{id}/fans/{group}',
      '/runs/{id}/stream',
      '/runs/{id}/retry',
      '/runs/{id}/retry-with-input',
      '/runs/{id}/redispatch',
      '/runs/{id}/republish-lifecycle',
      '/runs/{id}/cancel',
      '/runs/{id}/continue',
      '/runs/{id}/signal',
      '/runs/{id}/updates/{name}',
      '/runs/{id}/tasks/{name}/complete',
      '/runs/{id}/tasks/{name}/fail',
      '/runs/{id}/events/{key}',
      '/webhooks/{token}',
      '/metrics',
      '/bulk/{action}',
      '/workflows/{name}/lifecycle',
      '/schedules',
      '/schedules/{key}/{action}',
      '/health',
      '/workers',
      '/topology',
      '/compat',
      '/openapi.json',
      '/apps',
    ];
    for (const path of expected) expect(doc.paths[path], path).toBeDefined();
    expect(Object.keys(doc.paths).sort()).toEqual([...expected].sort());
  });

  it('documents the federated console: ?app= on every app-scoped route, the /apps selector', () => {
    const doc = openApiDocument('/durable/api') as {
      components: { parameters: Record<string, { name: string; in: string }> };
      paths: Record<string, Record<string, { parameters?: Array<{ $ref?: string }> }>>;
    };
    expect(doc.components.parameters.App).toMatchObject({ name: 'app', in: 'query' });
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const scoped = (operation.parameters ?? []).some(
          (p) => p.$ref === '#/components/parameters/App',
        );
        expect(scoped, `${method.toUpperCase()} ${path}`).toBe(
          path !== '/openapi.json' && path !== '/apps',
        );
      }
    }
    expect(doc.paths['/apps']?.get).toBeDefined();
  });

  it("documents each app's mode and who runs actions, both optional", () => {
    const doc = openApiDocument('/durable/api') as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const ok = doc.paths['/apps']?.get?.responses['200'] as {
      content: { 'application/json': { schema: { properties: { apps: { items: unknown } } } } };
    };
    const item = ok.content['application/json'].schema.properties.apps.items as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(item.properties.mode?.enum).toEqual(['control-plane', 'federated']);
    expect(item.properties.actions?.enum).toEqual(['here', 'app', 'none']);
    expect(item.required).toEqual(['id', 'label']);
  });
});

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
      '/runs/{id}/stream',
      '/runs/{id}/retry',
      '/runs/{id}/retry-with-input',
      '/runs/{id}/redispatch',
      '/runs/{id}/cancel',
      '/runs/{id}/continue',
      '/runs/{id}/signal',
      '/runs/{id}/update/{name}',
      '/runs/{id}/tasks/{name}/complete',
      '/runs/{id}/tasks/{name}/fail',
      '/bulk/{action}',
      '/schedules',
      '/schedules/{key}/{action}',
      '/health',
      '/workers',
      '/topology',
      '/compat',
      '/openapi.json',
    ];
    for (const path of expected) expect(doc.paths[path], path).toBeDefined();
    expect(Object.keys(doc.paths).sort()).toEqual([...expected].sort());
  });
});

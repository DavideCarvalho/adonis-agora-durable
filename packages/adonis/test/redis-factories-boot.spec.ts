import { describe, expect, it, vi } from 'vitest';

// `@adonisjs/redis/services/main` is only assigned in `app.booted()`: during the durable provider's
// boot its default export is still `undefined`. Model exactly that.
vi.mock('@adonisjs/redis/services/main', () => ({ default: undefined }));

const built: Array<{ kind: string; options: Record<string, unknown> }> = [];
vi.mock('../src/control-plane-redis/redis-control-plane.js', () => ({
  RedisControlPlane: class {
    constructor(options: Record<string, unknown>) {
      built.push({ kind: 'control-plane', options });
    }
  },
}));
vi.mock('../src/admission-redis/index.js', () => ({
  RedisAdmissionBackend: class {
    constructor(options: Record<string, unknown>) {
      built.push({ kind: 'admission', options });
    }
  },
}));

const { controlPlanes } = await import('../src/control-planes/factory.js');
const { admissions } = await import('../src/admissions/factory.js');

function bootingApp(bound: boolean) {
  const connections: string[] = [];
  const manager = {
    connection: (name?: string) => {
      connections.push(name ?? 'main');
      return { name };
    },
  };
  const app = {
    container: {
      make: async (service: unknown) => {
        if (service === 'redis' && bound) return manager;
        throw new Error(`cannot resolve ${String(service)}`);
      },
    },
    config: { get: <T>(_key: string, fallback?: T) => fallback as T },
  };
  return { app, connections };
}

describe('Redis-backed factories at provider boot', () => {
  it('controlPlanes.redis resolves the redis manager from the container, not services/main', async () => {
    built.length = 0;
    const { app, connections } = bootingApp(true);
    await controlPlanes.redis({ connection: 'pubsub', prefix: 'app' })({ app });
    expect(connections).toEqual(['pubsub']);
    expect(built).toEqual([
      { kind: 'control-plane', options: { connection: { name: 'pubsub' }, prefix: 'app' } },
    ]);
  });

  it('admissions.redis resolves the redis manager from the container, not services/main', async () => {
    built.length = 0;
    const { app, connections } = bootingApp(true);
    await admissions.redis()({ app });
    expect(connections).toEqual(['main']);
    expect(built[0]?.kind).toBe('admission');
  });

  it('fails with an actionable error when @adonisjs/redis is not registered', async () => {
    const { app } = bootingApp(false);
    await expect(controlPlanes.redis()({ app })).rejects.toThrow(/redis_provider/);
    await expect(admissions.redis()({ app })).rejects.toThrow(/redis_provider/);
  });
});

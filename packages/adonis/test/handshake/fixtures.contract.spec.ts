import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  descriptorHash,
  type HeartbeatStatus,
  type WorkerDescriptor,
} from '../../src/handshake/descriptor.js';

/**
 * Cross-SDK contract test (design §7.8). These golden fixtures are the polyglot wire contract: the
 * adonis, nestjs and python SDKs must each serialize to and parse from these exact bytes. Here we
 * assert the adonis side round-trips them byte-identically and that the heartbeat ETag matches the
 * descriptor it advertises.
 */

const wireDir = fileURLToPath(new URL('../fixtures/wire/', import.meta.url));
const readRaw = (name: string): string => readFileSync(`${wireDir}${name}`, 'utf8');

describe('golden fixture: descriptor.json', () => {
  const raw = readRaw('descriptor.json');
  const parsed = JSON.parse(raw) as WorkerDescriptor;

  it('parses into a well-formed WorkerDescriptor', () => {
    expect(parsed.instanceId).toBe('ts-billing-01-4821');
    expect(parsed.runtime).toBe('node');
    expect(parsed.protocol).toEqual({ version: 1, range: [1, 1] });
    expect(parsed.capabilities).toContain('search-attr-v2');
    expect(parsed.workflows).toEqual(['CheckoutWorkflow', 'RefundWorkflow']);
  });

  it('round-trips byte-identically (serialize(parse(bytes)) === bytes)', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
  });
});

/** The pinned hash of the announcement fixture — verified equal in the Python SDK's test_handshake. */
const GOLDEN_REGISTRATIONS_HASH = '8923307c940a5dde';

describe('golden fixture: descriptor-registrations.json (design §7.9)', () => {
  const raw = readRaw('descriptor-registrations.json');
  const parsed = JSON.parse(raw) as WorkerDescriptor;

  it('parses a python worker announcing what it can execute', () => {
    expect(parsed.runtime).toBe('python');
    expect(parsed.registrations).toEqual([
      { name: 'extraction', group: 'extraction@acme' },
      {
        name: 'pipeline',
        version: '2',
        group: 'pipeline@acme',
        requires: ['saga'],
        origin: 'flip-python-db',
      },
    ]);
    // Every announced name is ALSO in `workflows`, so a reader predating §7.9 still sees them.
    expect(parsed.workflows).toEqual(['extraction', 'pipeline']);
  });

  it('round-trips byte-identically (serialize(parse(bytes)) === bytes)', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
  });

  it('computes the pinned cross-language hash (8923307c940a5dde)', () => {
    expect(descriptorHash(parsed)).toBe(GOLDEN_REGISTRATIONS_HASH);
  });

  it('hashes differently WITHOUT its announcement — the ETag tracks what a worker serves', () => {
    const { registrations, ...withoutAnnouncement } = parsed;
    expect(registrations).toBeDefined();
    expect(descriptorHash(withoutAnnouncement)).not.toBe(GOLDEN_REGISTRATIONS_HASH);
  });
});

/** The pinned hash of the onError-routes fixture — verified equal in the Python SDK's test_handshake. */
const GOLDEN_ON_ERROR_HASH = 'd2be2d3bfe108eda';

describe('golden fixture: descriptor-on-error.json (announced onError routes)', () => {
  const raw = readRaw('descriptor-on-error.json');
  const parsed = JSON.parse(raw) as WorkerDescriptor;

  it('parses the routes a worker announces for a workflow', () => {
    expect(parsed.registrations?.[0]?.onError).toEqual([
      { code: 'invalid_line', workflow: 'line-dead-letter' },
      { workflow: 'line-failure' },
    ]);
  });

  it('round-trips byte-identically (serialize(parse(bytes)) === bytes)', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
  });

  it('computes the pinned cross-language hash (d2be2d3bfe108eda)', () => {
    expect(descriptorHash(parsed)).toBe(GOLDEN_ON_ERROR_HASH);
  });

  it('hashes the same whatever order the routes are listed in', () => {
    const [line, ...rest] = parsed.registrations ?? [];
    const reversed = { ...line, onError: [...(line?.onError ?? [])].reverse() };
    expect(
      descriptorHash({ ...parsed, registrations: [reversed as typeof line, ...rest] as never }),
    ).toBe(GOLDEN_ON_ERROR_HASH);
  });
});

describe('golden fixture: heartbeat-status.json (two-tier ETag)', () => {
  const raw = readRaw('heartbeat-status.json');
  const parsed = JSON.parse(raw) as HeartbeatStatus;

  it('parses into a well-formed HeartbeatStatus', () => {
    expect(parsed.status).toBe('up');
    expect(parsed.ts).toBe(1752710460000);
    expect(parsed.descriptorHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('round-trips byte-identically', () => {
    expect(`${JSON.stringify(parsed, null, 2)}\n`).toBe(raw);
  });

  it("its descriptorHash equals the descriptor fixture's computed hash (the ETag contract)", () => {
    const descriptor = JSON.parse(readRaw('descriptor.json')) as WorkerDescriptor;
    expect(parsed.descriptorHash).toBe(descriptorHash(descriptor));
  });
});

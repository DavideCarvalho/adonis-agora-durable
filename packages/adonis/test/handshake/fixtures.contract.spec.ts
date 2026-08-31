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

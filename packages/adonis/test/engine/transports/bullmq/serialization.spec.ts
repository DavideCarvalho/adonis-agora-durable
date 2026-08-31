import { describe, expect, it } from 'vitest';
import {
  buildInstanceId,
  heartbeatKeyValue,
  jobOptions,
  parseHeartbeatValue,
  TASK_FAILED_RETENTION_SECONDS,
  taskJobOptions,
  toBrokerPriority,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '../../../../src/transports/bullmq/serialization.js';

describe('bullmq serialization', () => {
  describe('toBrokerPriority — inverted, clamped (spec §6.3)', () => {
    it('returns undefined for an absent priority (default FIFO path untouched)', () => {
      expect(toBrokerPriority(undefined)).toBeUndefined();
    });

    it('inverts around the baseline so "higher engine priority" = "lower broker number"', () => {
      expect(toBrokerPriority(0)).toBe(1_048_576);
      expect(toBrokerPriority(5)).toBe(1_048_571); // 1_048_576 - 5
      expect(toBrokerPriority(-5)).toBe(1_048_581);
    });

    it("clamps into BullMQ's [1, 2_097_151] range", () => {
      expect(toBrokerPriority(2_000_000)).toBe(1); // would be negative → clamp low
      expect(toBrokerPriority(-2_000_000)).toBe(2_097_151); // would exceed max → clamp high
    });
  });

  describe('job options (spec §6.3)', () => {
    it('non-task jobs remove on complete AND fail, no priority key when absent', () => {
      expect(jobOptions()).toEqual({ removeOnComplete: true, removeOnFail: true });
      expect(jobOptions(5)).toEqual({
        removeOnComplete: true,
        removeOnFail: true,
        priority: 1_048_571,
      });
    });

    it('task dispatch overrides removeOnFail with age-bounded retention', () => {
      expect(taskJobOptions()).toEqual({
        removeOnComplete: true,
        removeOnFail: { age: TASK_FAILED_RETENTION_SECONDS },
      });
      expect(TASK_FAILED_RETENTION_SECONDS).toBe(86_400);
    });
  });

  describe('instanceId', () => {
    it('is ts-<host>-<pid>', () => {
      expect(buildInstanceId('box', 4242)).toBe('ts-box-4242');
    });
  });

  describe('worker-liveness cadence + value', () => {
    it('refreshes every 10s with a 35s TTL', () => {
      expect(WORKER_HEARTBEAT_INTERVAL_MS).toBe(10_000);
      expect(WORKER_HEARTBEAT_TTL_SECONDS).toBe(35);
    });

    it('writes {"ts": <epochMs>} and reads it back (ms)', () => {
      expect(heartbeatKeyValue(1_752_710_400_000)).toBe('{"ts":1752710400000}');
      expect(parseHeartbeatValue('{"ts":1752710400000}')).toEqual({
        lastBeatAt: 1_752_710_400_000,
      });
    });

    it('reads a legacy seconds value (< 1e12) as ms', () => {
      expect(parseHeartbeatValue('1752710400')).toEqual({ lastBeatAt: 1_752_710_400_000 });
      expect(parseHeartbeatValue('{"ts":1752710400}')).toEqual({
        lastBeatAt: 1_752_710_400_000,
      });
    });

    it('is robust to a missing/garbled value', () => {
      expect(parseHeartbeatValue(null)).toEqual({ lastBeatAt: 0 });
      expect(parseHeartbeatValue('')).toEqual({ lastBeatAt: 0 });
      expect(parseHeartbeatValue('{bad')).toEqual({ lastBeatAt: 0 });
    });
  });
});

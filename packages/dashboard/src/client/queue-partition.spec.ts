import { describe, expect, it } from 'vitest';
import { baseHandlerName, partitionOf } from './queue-partition.js';

describe('queue-partition', () => {
  it('reads the partition off a tenant-suffixed token', () => {
    expect(partitionOf('pipeline@davi-local')).toBe('davi-local');
    expect(partitionOf('handle_MEL@davi-local')).toBe('davi-local');
  });

  it('defaults to "default" for an unsuffixed (operator) token', () => {
    expect(partitionOf('pipeline')).toBe('default');
    expect(partitionOf('PipelineWorkflow.alertOnCall')).toBe('default');
  });

  it('strips the partition suffix to recover the handler name', () => {
    expect(baseHandlerName('pipeline@davi-local')).toBe('pipeline');
    expect(baseHandlerName('PipelineWorkflow.alertOnCall')).toBe('PipelineWorkflow.alertOnCall');
  });
});

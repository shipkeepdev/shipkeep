import { create } from '@bufbuild/protobuf';
import { NodeFactsSchema } from '@shipkeep/proto-ts';

import { sanitizeFacts } from '../domain/node';

import { factsFromProto } from './node-facts';

describe('factsFromProto', () => {
  it('keeps capacity facts through sanitizing', () => {
    const facts = create(NodeFactsSchema, {
      hostname: 'edge-1.example.com',
      architecture: 'amd64',
      cpuCount: 4,
      memoryBytes: 8_589_934_592n,
      diskFreeBytes: 0n,
    });
    expect(sanitizeFacts(factsFromProto(facts))).toMatchObject({
      hostname: 'edge-1.example.com',
      architecture: 'amd64',
      cpu_count: 4,
      memory_bytes: 8_589_934_592,
      disk_free_bytes: 0,
    });
    expect(factsFromProto(undefined)).toEqual({});
  });
});

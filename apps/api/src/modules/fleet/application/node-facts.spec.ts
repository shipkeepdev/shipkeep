import { create, fromBinary } from '@bufbuild/protobuf';
import { NodeFactsSchema, NodeRole } from '@shipkeep/proto-ts';

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

  it('keeps the role the agent reports, and none from an agent that predates roles', () => {
    for (const [role, stored] of [
      [NodeRole.SERVER, 'server'],
      [NodeRole.CONTROL_PLANE, 'control-plane'],
      [NodeRole.CONTROL_PLANE_ONLY, 'control-plane-only'],
    ] as const)
      expect(sanitizeFacts(factsFromProto(create(NodeFactsSchema, { role })))['role']).toBe(stored);
    expect(factsFromProto(create(NodeFactsSchema, {}))).not.toHaveProperty('role');
    // A value outside the enum, from a newer or a forged agent, is not stored: field 16, 99.
    const forged = fromBinary(NodeFactsSchema, new Uint8Array([0x80, 0x01, 0x63]));
    expect(forged.role).toBe(99);
    expect(factsFromProto(forged)).not.toHaveProperty('role');
  });
});

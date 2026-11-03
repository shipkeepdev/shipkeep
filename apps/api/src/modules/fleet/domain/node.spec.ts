import { InvalidInputError } from '@shipkeep/domain';

import {
  assertNodeName,
  nodeNameFromHostname,
  nodeSpiffeId,
  parseNodeSpiffeId,
  sanitizeFacts,
} from './node';

describe('node names', () => {
  it('accepts valid names and rejects the rest', () => {
    expect(() => {
      assertNodeName('edge-1');
    }).not.toThrow();
    for (const bad of ['Edge', '1edge', 'e', 'edge-', 'a'.repeat(41), 'edge_1', 'edge 1']) {
      expect(() => {
        assertNodeName(bad);
      }).toThrow(InvalidInputError);
    }
  });

  it('derives names from hostnames', () => {
    expect(nodeNameFromHostname('Edge-1.internal.example.com')).toBe('edge-1');
    expect(nodeNameFromHostname('web_01')).toBe('web-01');
    expect(nodeNameFromHostname('--')).toBeUndefined();
    expect(nodeNameFromHostname('1abc')).toBeUndefined();
    expect(nodeNameFromHostname(`${'x'.repeat(60)}.local`)).toBe('x'.repeat(40));
  });
});

describe('sanitizeFacts', () => {
  it('keeps well-typed bounded facts and drops everything else', () => {
    const facts = sanitizeFacts({
      hostname: 'edge-1',
      cpu_count: 4,
      memory_bytes: 8n * 1024n ** 3n,
      os: 'x'.repeat(1000),
      'bad key': 'x',
      Upper: 'x',
      nested: { a: 1 },
      list: [1],
      nan: Number.NaN,
      empty: '',
    });
    expect(facts).toEqual({
      hostname: 'edge-1',
      cpu_count: 4,
      memory_bytes: 8 * 1024 ** 3,
      os: 'x'.repeat(256),
    });
  });

  it('caps the number of facts', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${String(i)}`, 'v']));
    expect(Object.keys(sanitizeFacts(many))).toHaveLength(64);
  });
});

describe('SPIFFE ids', () => {
  const org = '0192f0c0-0000-7000-8000-0000000000aa';
  const node = '0192f0c0-0000-7000-8000-0000000000bb';

  it('round-trips', () => {
    const uri = nodeSpiffeId(org, node);
    expect(uri).toBe(`spiffe://shipkeep/${org}/node/${node}`);
    expect(parseNodeSpiffeId(uri)).toEqual({ organizationId: org, nodeId: node });
  });

  it('rejects foreign or malformed identities', () => {
    expect(parseNodeSpiffeId(`spiffe://other/${org}/node/${node}`)).toBeUndefined();
    expect(parseNodeSpiffeId(`spiffe://shipkeep/${org}/user/${node}`)).toBeUndefined();
    expect(parseNodeSpiffeId(`spiffe://shipkeep/${org}/node/../${node}`)).toBeUndefined();
    expect(parseNodeSpiffeId('')).toBeUndefined();
  });
});

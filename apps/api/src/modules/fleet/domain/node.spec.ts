import { InvalidInputError } from '@shipkeep/domain';

import {
  assertNodeName,
  nodeNameFromHostname,
  nodeSpiffeId,
  observedStatus,
  parseNodeSpiffeId,
  sanitizeFacts,
  statusAfterHeartbeat,
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

describe('node liveness', () => {
  const now = new Date('2026-11-05T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('reads a ready node as suspect after 15 s and down after 60 s without heartbeat', () => {
    expect(observedStatus({ status: 'ready', lastHeartbeatAt: ago(14_999) }, now)).toBe('ready');
    expect(observedStatus({ status: 'ready', lastHeartbeatAt: ago(15_000) }, now)).toBe('suspect');
    expect(observedStatus({ status: 'ready', lastHeartbeatAt: ago(60_000) }, now)).toBe('down');
    expect(observedStatus({ status: 'ready', lastHeartbeatAt: null }, now)).toBe('down');
    // A clock skewed into the future never makes a node look healthier than ready.
    expect(observedStatus({ status: 'ready', lastHeartbeatAt: ago(-5_000) }, now)).toBe('ready');
  });

  it('keeps other stored statuses as they are', () => {
    for (const status of ['enrolling', 'draining', 'removed', 'suspect', 'down'] as const)
      expect(observedStatus({ status, lastHeartbeatAt: ago(120_000) }, now)).toBe(status);
  });

  it('makes a heartbeating node ready unless it is draining or removed', () => {
    expect(statusAfterHeartbeat('enrolling')).toBe('ready');
    expect(statusAfterHeartbeat('suspect')).toBe('ready');
    expect(statusAfterHeartbeat('down')).toBe('ready');
    expect(statusAfterHeartbeat('ready')).toBe('ready');
    expect(statusAfterHeartbeat('draining')).toBe('draining');
    expect(statusAfterHeartbeat('removed')).toBe('removed');
  });
});

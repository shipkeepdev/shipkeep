import { placeReplicas } from '@shipkeep/domain';

import { type NodeView, placementRequest, schedulableNodes } from './placement';

const NOW = new Date('2026-11-05T12:00:00Z');
const node = (name: string, overrides: Partial<NodeView> = {}): NodeView => ({
  id: `id-${name}`,
  name,
  status: 'ready',
  lastHeartbeatAt: new Date(NOW.getTime() - 5_000),
  labels: {},
  facts: { architecture: 'amd64', cpu_count: 2, memory_bytes: 4 * 2 ** 30 },
  ...overrides,
});

describe('schedulableNodes', () => {
  it('reads capacity from facts, load from allocations and liveness from heartbeats', () => {
    const nodes = schedulableNodes(
      [
        node('edge-1'),
        node('edge-2', { lastHeartbeatAt: new Date(NOW.getTime() - 90_000) }),
        node('edge-3', { status: 'removed' }),
        node('edge-4', { facts: { cpu_count: -1, memory_bytes: 1.5 } }),
      ],
      new Map([['id-edge-1', { cpuMillis: 500, memoryBytes: 2 ** 30, applications: ['app-a'] }]]),
      NOW,
    );
    expect(nodes.map((n) => [n.name, n.status])).toEqual([
      ['edge-1', 'ready'],
      ['edge-2', 'down'],
      ['edge-4', 'ready'],
    ]);
    expect(nodes[0]).toMatchObject({
      architecture: 'amd64',
      capacity: { cpuMillis: 2000, memoryBytes: 4 * 2 ** 30 },
      reserved: { cpuMillis: 500, memoryBytes: 2 ** 30 },
      apps: ['app-a'],
    });
    expect(nodes[2]).toMatchObject({
      architecture: '',
      capacity: { cpuMillis: 0, memoryBytes: 0 },
    });
  });
});

describe('placementRequest', () => {
  it('spreads replicas over ready nodes within their capacity', () => {
    const request = placementRequest('app-a', {
      version: 1,
      name: 'billing-api',
      build: { type: 'image', image: 'nginx' },
      run: { port: 80 },
      resources: { cpu: '1', memory: '1Gi' },
      scale: { replicas: 3, placement: { labels: { region: 'eu' } } },
    });
    expect(request).toMatchObject({ spread: 'node', labels: { region: 'eu' }, ports: [] });
    const nodes = schedulableNodes(
      [
        node('edge-1', { labels: { region: 'eu' } }),
        node('edge-2', { labels: { region: 'eu' } }),
        node('edge-3'),
      ],
      new Map(),
      NOW,
    );
    // Two cores per node: three one-core replicas land on both eu nodes, never on edge-3.
    expect(placeReplicas(request, 3, nodes)).toEqual({
      nodes: ['edge-1', 'edge-2', 'edge-1'],
      unplaced: 0,
    });
    expect(placeReplicas(request, 5, nodes).unplaced).toBe(1);
  });
});

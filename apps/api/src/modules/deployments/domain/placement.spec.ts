import { placeReplicas } from '@shipkeep/domain';

import { type NodeView, placementRequest, schedulableNodes, withoutReplaced } from './placement';

const NOW = new Date('2026-11-05T12:00:00Z');
/** One CPU and 512 MiB: what an application without `resources` runs under (#301). */
const DEFAULT_LIMITS = { cpuMillis: 1000, memoryBytes: 536_870_912 };
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

  it('reserves the default limits for an application without resources', () => {
    const request = placementRequest('app-a', {
      version: 1,
      name: 'billing-api',
      build: { type: 'image', image: 'nginx' },
      run: { port: 80 },
    });
    expect(request.resources).toEqual(DEFAULT_LIMITS);
    // One core each: a two-core node takes two of them, and the third has no room.
    expect(placeReplicas(request, 3, schedulableNodes([node('edge-1')], new Map(), NOW))).toEqual({
      nodes: ['edge-1', 'edge-1'],
      unplaced: 1,
    });
  });
});

describe('withoutReplaced', () => {
  const single = { ...DEFAULT_LIMITS, applications: ['app-a'] };
  const request = placementRequest('app-a', {
    version: 1,
    name: 'billing-api',
    build: { type: 'image', image: 'nginx' },
    run: { port: 80 },
  });
  const oneCore = node('edge-1', {
    facts: { architecture: 'amd64', cpu_count: 1, memory_bytes: 2 ** 31 },
  });

  it('lets a new release take the room of the replicas it replaces', () => {
    const load = new Map([['id-edge-1', single]]);
    // Counting both releases, a node the application fills could never run its next release.
    expect(placeReplicas(request, 1, schedulableNodes([oneCore], load, NOW)).unplaced).toBe(1);
    const freed = withoutReplaced(load, [{ nodeId: 'id-edge-1', ...DEFAULT_LIMITS }]);
    expect(freed.get('id-edge-1')).toEqual({
      cpuMillis: 0,
      memoryBytes: 0,
      applications: ['app-a'],
    });
    expect(placeReplicas(request, 1, schedulableNodes([oneCore], freed, NOW))).toEqual({
      nodes: ['edge-1'],
      unplaced: 0,
    });
    // The stored load is not modified.
    expect(load.get('id-edge-1')).toEqual(single);
  });

  it('frees nothing for another application or another node', () => {
    const load = new Map([
      ['id-edge-1', single],
      ['id-edge-2', { cpuMillis: 500, memoryBytes: 2 ** 20, applications: ['app-b'] }],
    ]);
    expect(withoutReplaced(load, [])).toEqual(load);
    const other = placementRequest('app-b', {
      version: 1,
      name: 'worker',
      build: { type: 'image', image: 'nginx' },
      run: { port: 80 },
    });
    // The node is full with app-a: app-b replaces nothing there and is refused for CPU.
    expect(
      placeReplicas(other, 1, schedulableNodes([oneCore], withoutReplaced(load, []), NOW)),
    ).toEqual({ nodes: [], unplaced: 1 });
    // A replica on a node missing from the load frees nothing anywhere.
    expect(withoutReplaced(load, [{ nodeId: 'id-edge-3', ...DEFAULT_LIMITS }])).toEqual(load);
    // A replica on edge-2 frees room on edge-2 only.
    expect(
      withoutReplaced(load, [{ nodeId: 'id-edge-2', cpuMillis: 500, memoryBytes: 2 ** 20 }]),
    ).toEqual(
      new Map([
        ['id-edge-1', single],
        ['id-edge-2', { cpuMillis: 0, memoryBytes: 0, applications: ['app-b'] }],
      ]),
    );
  });

  it('never reports a negative load', () => {
    const load = new Map([['id-edge-1', { cpuMillis: 300, memoryBytes: 10, applications: [] }]]);
    expect(
      withoutReplaced(load, [
        { nodeId: 'id-edge-1', cpuMillis: 200, memoryBytes: 8 },
        { nodeId: 'id-edge-1', cpuMillis: 200, memoryBytes: 8 },
      ]).get('id-edge-1'),
    ).toEqual({ cpuMillis: 0, memoryBytes: 0, applications: [] });
  });
});

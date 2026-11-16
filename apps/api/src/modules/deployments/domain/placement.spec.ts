import { placeReplica, placeReplicas } from '@shipkeep/domain';

import { nodeLoads, type NodeView, placementRequest, schedulableNodes } from './placement';

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

describe('nodes without capacity facts', () => {
  const request = placementRequest('app-a', {
    version: 1,
    name: 'billing-api',
    build: { type: 'image', image: 'nginx' },
    run: { port: 80 },
  });

  it('places on the ready node and says why the others were skipped', () => {
    const nodes = schedulableNodes(
      [
        node('edge-1', { facts: {} }),
        node('edge-2', { facts: { architecture: 'amd64', memory_bytes: 4 * 2 ** 30 } }),
        node('edge-3', { facts: { architecture: 'amd64', cpu_count: 2 } }),
        node('edge-4'),
      ],
      new Map(),
      NOW,
    );
    // One node without facts used to make placement throw for the whole organization (#314).
    expect(placeReplicas(request, 1, nodes)).toEqual({ nodes: ['edge-4'], unplaced: 0 });
    expect(placeReplica(request, nodes.slice(0, 3))).toEqual({
      placed: false,
      rejections: { 'edge-1': 'architecture', 'edge-2': 'cpu', 'edge-3': 'memory' },
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

describe('nodeLoads', () => {
  const request = placementRequest('app-a', {
    version: 1,
    name: 'billing-api',
    build: { type: 'image', image: 'nginx' },
    run: { port: 80 },
  });
  const oneCore = node('edge-1', {
    facts: { architecture: 'amd64', cpu_count: 1, memory_bytes: 2 ** 31 },
  });
  const replica = (applicationId: string, releaseId: string, nodeId = 'id-edge-1') => ({
    nodeId,
    applicationId,
    releaseId,
    ...DEFAULT_LIMITS,
  });
  const serving = [replica('app-a', 'release-1')];

  it('sums the placed replicas of each node', () => {
    expect(
      nodeLoads([
        replica('app-a', 'release-1'),
        replica('app-b', 'release-9'),
        replica('app-a', 'release-1', 'id-edge-2'),
      ]),
    ).toEqual(
      new Map([
        ['id-edge-1', { cpuMillis: 2000, memoryBytes: 2 ** 30, applications: ['app-a', 'app-b'] }],
        ['id-edge-2', { ...DEFAULT_LIMITS, applications: ['app-a'] }],
      ]),
    );
  });

  it('lets a new release take the room of the replicas it replaces', () => {
    // Counting both releases, a node the application fills could never run its next release.
    expect(
      placeReplicas(request, 1, schedulableNodes([oneCore], nodeLoads(serving), NOW)).unplaced,
    ).toBe(1);
    const freed = nodeLoads(serving, { applicationId: 'app-a', releaseId: 'release-2' });
    // The application still counts on the node, for spread.
    expect(freed.get('id-edge-1')).toEqual({
      cpuMillis: 0,
      memoryBytes: 0,
      applications: ['app-a'],
    });
    expect(placeReplicas(request, 1, schedulableNodes([oneCore], freed, NOW))).toEqual({
      nodes: ['edge-1'],
      unplaced: 0,
    });
  });

  it('keeps the reservation of the release being placed and of other applications', () => {
    const placed = [
      replica('app-a', 'release-1'),
      replica('app-a', 'release-2'),
      replica('app-b', 'release-1'),
      replica('app-b', 'release-1', 'id-edge-2'),
    ];
    // Only app-a's release 1 is replaced: one replica on edge-1, nothing on edge-2.
    expect(nodeLoads(placed, { applicationId: 'app-a', releaseId: 'release-2' })).toEqual(
      new Map([
        ['id-edge-1', { cpuMillis: 2000, memoryBytes: 2 ** 30, applications: ['app-a', 'app-b'] }],
        ['id-edge-2', { ...DEFAULT_LIMITS, applications: ['app-b'] }],
      ]),
    );
    // The node is full with app-a: app-b replaces nothing there and is refused for CPU.
    const other = placementRequest('app-b', {
      version: 1,
      name: 'worker',
      build: { type: 'image', image: 'nginx' },
      run: { port: 80 },
    });
    const loads = nodeLoads(serving, { applicationId: 'app-b', releaseId: 'release-1' });
    expect(placeReplicas(other, 1, schedulableNodes([oneCore], loads, NOW))).toEqual({
      nodes: [],
      unplaced: 1,
    });
  });

  it('frees nothing for replicas that are no longer placed', () => {
    // The replaced replicas were stopped meanwhile: they are not in the read, so their room is
    // not freed a second time and the other application keeps its whole reservation.
    expect(
      nodeLoads([replica('app-b', 'release-1')], {
        applicationId: 'app-a',
        releaseId: 'release-2',
      }),
    ).toEqual(new Map([['id-edge-1', { ...DEFAULT_LIMITS, applications: ['app-b'] }]]));
  });
});

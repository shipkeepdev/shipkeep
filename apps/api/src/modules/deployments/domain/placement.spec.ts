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

describe('machines that run the control plane alone', () => {
  it('are never offered to an application; the single machine still is (ADR 0021, 0028)', () => {
    const facts = { architecture: 'amd64', cpu_count: 8, memory_bytes: 16 * 2 ** 30 };
    const nodes = schedulableNodes(
      [
        node('control', { facts: { ...facts, role: 'control-plane-only' } }),
        node('single', { facts: { ...facts, role: 'control-plane', reserved_cpu_millis: 2000 } }),
        node('server', { facts: { ...facts, role: 'server' } }),
        node('older-agent', { facts }),
      ],
      new Map(),
      NOW,
    );
    expect(nodes.map((n) => n.name)).toEqual(['single', 'server', 'older-agent']);
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
      rejections: { 'edge-1': 'cpu' },
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
      replaced: DEFAULT_LIMITS,
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
        [
          'id-edge-1',
          {
            cpuMillis: 2000,
            memoryBytes: 2 ** 30,
            applications: ['app-a', 'app-b'],
            replaced: DEFAULT_LIMITS,
          },
        ],
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
      rejections: { 'edge-1': 'cpu' },
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

/** The single node of a list, or a failed test. */
function only<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined || items.length !== 1)
    throw new Error(`expected one item, got ${String(items.length)}`);
  return item;
}

describe('the machine that hosts the control plane (ADR 0021)', () => {
  const GiB = 2 ** 30;
  const request = placementRequest('app-a', {
    version: 1,
    name: 'billing-api',
    build: { type: 'image', image: 'nginx' },
    run: { port: 80 },
    resources: { cpu: '1', memory: '1536Mi' },
  });
  // 4 CPUs and 4 GiB, of which 0.5 CPU and 1 GiB are kept for the control plane.
  const shared = node('cp', {
    facts: {
      architecture: 'amd64',
      cpu_count: 4,
      memory_bytes: 4 * GiB,
      reserved_cpu_millis: 500,
      reserved_memory_bytes: GiB,
    },
  });
  const replica = (releaseId: string) => ({
    nodeId: 'id-cp',
    applicationId: 'app-a',
    releaseId,
    cpuMillis: 1000,
    memoryBytes: 1.5 * GiB,
  });
  const replacing = { applicationId: 'app-a', releaseId: 'release-2' };

  it('schedules on the machine minus the reservation', () => {
    const scheduled = only(schedulableNodes([shared], new Map(), NOW));
    expect(scheduled.capacity).toEqual({ cpuMillis: 3500, memoryBytes: 3 * GiB });
  });

  it('counts the release being replaced and refuses a redeployment that does not fit beside it', () => {
    const loads = nodeLoads([replica('release-1')], replacing);
    const scheduled = only(schedulableNodes([shared], loads, NOW));
    expect(scheduled).toMatchObject({
      reserved: { cpuMillis: 0, memoryBytes: 0 },
      surge: { cpuMillis: 1000, memoryBytes: 1.5 * GiB },
    });
    // 1.5 GiB old + 1.5 GiB new fits in 3 GiB; a second replica of 1.5 GiB does not.
    expect(placeReplicas({ ...request, spread: 'none' }, 2, [scheduled])).toEqual({
      nodes: ['cp'],
      unplaced: 1,
      rejections: { cp: 'surge' },
    });
    expect(placeReplica({ ...request, spread: 'none' }, [scheduled])).toEqual({
      placed: true,
      node: 'cp',
    });
    const bigger = { ...request, resources: { cpuMillis: 1000, memoryBytes: 2 * GiB } };
    expect(placeReplica(bigger, [scheduled])).toEqual({
      placed: false,
      rejections: { cp: 'surge' },
    });
  });

  it('keeps the usual rule on a node without a reservation', () => {
    const edge = node('edge', {
      facts: { architecture: 'amd64', cpu_count: 4, memory_bytes: 3 * GiB },
    });
    const loads = nodeLoads([{ ...replica('release-1'), nodeId: 'id-edge' }], replacing);
    const scheduled = only(schedulableNodes([edge], loads, NOW));
    expect(scheduled.surge).toBeUndefined();
    const bigger = { ...request, resources: { cpuMillis: 1000, memoryBytes: 2 * GiB } };
    expect(placeReplica(bigger, [scheduled])).toEqual({ placed: true, node: 'edge' });
  });

  it('leaves no room when the reservation is the whole machine, and ignores bad values', () => {
    const full = node('full', {
      facts: {
        architecture: 'amd64',
        cpu_count: 1,
        memory_bytes: GiB,
        reserved_cpu_millis: 2000,
        reserved_memory_bytes: 2 * GiB,
      },
    });
    const odd = node('odd', {
      facts: {
        architecture: 'amd64',
        cpu_count: 2,
        memory_bytes: GiB,
        reserved_cpu_millis: -500,
        reserved_memory_bytes: 'lots',
      },
    });
    const [fullNode, oddNode] = schedulableNodes([full, odd], new Map(), NOW);
    expect(fullNode.capacity).toEqual({ cpuMillis: 0, memoryBytes: 0 });
    expect(oddNode.capacity).toEqual({ cpuMillis: 2000, memoryBytes: GiB });
    expect(oddNode.surge).toBeUndefined();
  });
});

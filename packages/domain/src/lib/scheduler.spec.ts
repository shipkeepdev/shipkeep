import {
  type PlacementRequest,
  placeReplica,
  placeReplicas,
  type SchedulableNode,
} from './scheduler.js';

const GiB = 1024 ** 3;
function node(name: string, overrides: Partial<SchedulableNode> = {}): SchedulableNode {
  return {
    name,
    status: 'ready',
    architecture: 'amd64',
    labels: {},
    capacity: { cpuMillis: 4000, memoryBytes: 8 * GiB },
    reserved: { cpuMillis: 0, memoryBytes: 0 },
    usedPorts: [],
    apps: [],
    volumes: [],
    ...overrides,
  };
}
const request: PlacementRequest = {
  app: 'api',
  architectures: ['amd64'],
  resources: { cpuMillis: 500, memoryBytes: 512 * 1024 ** 2 },
  labels: {},
  ports: [],
  spread: 'node',
  nodes: [],
};

describe('SPEC 6 scheduler examples', () => {
  it('filters on status, architecture, labels, allow-list, capacity, ports and volume', () => {
    const decision = placeReplica(
      {
        ...request,
        labels: { region: 'eu' },
        ports: [443],
        nodes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      },
      [
        node('a', { status: 'suspect', labels: { region: 'eu' } }),
        node('b', { architecture: 'arm64', labels: { region: 'eu' } }),
        node('c', { labels: { region: 'us' } }),
        node('d', { labels: { region: 'eu' }, reserved: { cpuMillis: 3800, memoryBytes: 0 } }),
        node('e', { labels: { region: 'eu' }, reserved: { cpuMillis: 0, memoryBytes: 8 * GiB } }),
        node('f', { labels: { region: 'eu' }, usedPorts: [443] }),
        node('h', { labels: { region: 'eu' } }),
      ],
    );
    expect(decision).toEqual({
      placed: false,
      rejections: {
        a: 'not_ready',
        b: 'architecture',
        c: 'labels',
        d: 'cpu',
        e: 'memory',
        f: 'ports',
        h: 'not_allowed',
      },
    });
  });

  it('ranks spread first, then memory ratio, CPU ratio and name', () => {
    expect(
      placeReplica(request, [
        node('busy', { reserved: { cpuMillis: 0, memoryBytes: 1 * GiB }, apps: [] }),
        node('idle', { apps: ['api'] }),
      ]),
    ).toEqual({ placed: true, node: 'busy' });
    expect(
      placeReplica({ ...request, spread: 'none' }, [
        node('busy', { reserved: { cpuMillis: 0, memoryBytes: 1 * GiB } }),
        node('idle', { apps: ['api'] }),
      ]),
    ).toEqual({ placed: true, node: 'idle' });
    expect(
      placeReplica(request, [
        node('b', { reserved: { cpuMillis: 1000, memoryBytes: 0 } }),
        node('a', { reserved: { cpuMillis: 2000, memoryBytes: 0 } }),
      ]),
    ).toEqual({ placed: true, node: 'b' });
    expect(placeReplica(request, [node('zeta'), node('alpha')])).toEqual({
      placed: true,
      node: 'alpha',
    });
  });

  it('pins stateful workloads to the node holding their volume, wherever ranking would go', () => {
    const nodes = [
      node('fresh'),
      node('holder', { reserved: { cpuMillis: 3000, memoryBytes: 6 * GiB }, volumes: ['db-data'] }),
    ];
    expect(placeReplica({ ...request, volume: 'db-data' }, nodes)).toEqual({
      placed: true,
      node: 'holder',
    });
    expect(placeReplica({ ...request, volume: 'new-volume' }, nodes)).toEqual({
      placed: true,
      node: 'fresh',
    });
    const full = [node('fresh'), node('holder', { status: 'down', volumes: ['db-data'] })];
    expect(placeReplica({ ...request, volume: 'db-data' }, full)).toEqual({
      placed: false,
      rejections: { fresh: 'volume', holder: 'not_ready' },
    });
  });

  it('spreads replicas, accounts for each placement and reports what does not fit', () => {
    const result = placeReplicas({ ...request, ports: [8080] }, 3, [node('a'), node('b')]);
    expect(result).toEqual({ nodes: ['a', 'b'], unplaced: 1 });
    expect(placeReplicas(request, 3, [node('a'), node('b')]).nodes).toEqual(['a', 'b', 'a']);
  });

  it('rejects malformed requests and node states', () => {
    for (const bad of [
      { ...request, app: '' },
      { ...request, architectures: [] },
      { ...request, resources: { cpuMillis: -1, memoryBytes: 0 } },
      { ...request, resources: { cpuMillis: 0.5, memoryBytes: 0 } },
      { ...request, ports: [0] },
      { ...request, ports: [70000] },
      { ...request, ports: [80, 80] },
    ])
      expect(() => placeReplica(bad, [node('a')])).toThrow('Invalid placement request.');
    expect(() => placeReplica(request, [node('a'), node('a')])).toThrow('unique');
    expect(() =>
      placeReplica(request, [node('a', { capacity: { cpuMillis: 0, memoryBytes: GiB } })]),
    ).toThrow('Invalid scheduling state');
    expect(() => placeReplicas(request, -1, [])).toThrow('Replicas must be');
  });
});

/** Small deterministic PRNG (mulberry32): property tests replay exactly from their seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function cluster(next: () => number): { request: PlacementRequest; nodes: SchedulableNode[] } {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
  const nodes = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, index) =>
    node(`node-${String(index)}`, {
      status: pick(['ready', 'ready', 'ready', 'suspect', 'down']),
      architecture: pick(['amd64', 'amd64', 'arm64']),
      labels: next() < 0.7 ? { region: pick(['eu', 'us']) } : {},
      capacity: { cpuMillis: pick([1000, 2000, 4000]), memoryBytes: pick([2, 4, 8]) * GiB },
      reserved: {
        cpuMillis: Math.floor(next() * 4) * 500,
        memoryBytes: Math.floor(next() * 8) * 512 * 1024 ** 2,
      },
      usedPorts: next() < 0.3 ? [443] : [],
      apps: next() < 0.4 ? ['api'] : [],
      volumes: next() < 0.2 ? ['data'] : [],
    }),
  );
  return {
    nodes,
    request: {
      ...request,
      architectures: next() < 0.8 ? ['amd64'] : ['amd64', 'arm64'],
      labels: next() < 0.5 ? { region: pick(['eu', 'us']) } : {},
      ports: next() < 0.3 ? [443] : [],
      spread: pick(['node', 'none'] as const),
      ...(next() < 0.3 ? { volume: 'data' } : {}),
    },
  };
}
function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
function fits(
  request: PlacementRequest,
  candidate: SchedulableNode,
  all: readonly SchedulableNode[],
) {
  const pinned =
    request.volume !== undefined && all.some((n) => n.volumes.includes(request.volume ?? ''));
  return (
    candidate.status === 'ready' &&
    request.architectures.includes(candidate.architecture) &&
    Object.entries(request.labels).every(([key, value]) => candidate.labels[key] === value) &&
    (!pinned || candidate.volumes.includes(request.volume ?? '')) &&
    candidate.reserved.cpuMillis + request.resources.cpuMillis <= candidate.capacity.cpuMillis &&
    candidate.reserved.memoryBytes + request.resources.memoryBytes <=
      candidate.capacity.memoryBytes &&
    !request.ports.some((port) => candidate.usedPorts.includes(port))
  );
}

describe('SPEC 6 scheduler properties', () => {
  it('is deterministic, honors every constraint and fails only when nothing fits', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const next = random(seed);
      const { request: wanted, nodes } = cluster(next);
      const decision = placeReplica(wanted, nodes);
      expect(placeReplica(wanted, shuffled(nodes, next)), `seed ${String(seed)}`).toEqual(decision);
      const fitting = nodes.filter((candidate) => fits(wanted, candidate, nodes));
      if (!decision.placed) {
        expect(fitting, `seed ${String(seed)}`).toEqual([]);
        continue;
      }
      const chosen = nodes.find((candidate) => candidate.name === decision.node);
      expect(chosen && fits(wanted, chosen, nodes), `seed ${String(seed)}`).toBe(true);
      if (wanted.spread === 'node' && fitting.some((candidate) => !candidate.apps.includes('api')))
        expect(chosen?.apps.includes('api'), `seed ${String(seed)}`).toBe(false);
    }
  });

  it('never overcommits a node across replicas', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const { request: wanted, nodes } = cluster(next);
      const result = placeReplicas({ ...wanted, ports: [] }, 1 + Math.floor(next() * 6), nodes);
      for (const candidate of nodes) {
        const count = result.nodes.filter((name) => name === candidate.name).length;
        expect(
          candidate.reserved.cpuMillis + count * wanted.resources.cpuMillis,
          `seed ${String(seed)}`,
        ).toBeLessThanOrEqual(Math.max(candidate.capacity.cpuMillis, candidate.reserved.cpuMillis));
        if (count > 0)
          expect(
            candidate.reserved.memoryBytes + count * wanted.resources.memoryBytes,
          ).toBeLessThanOrEqual(candidate.capacity.memoryBytes);
      }
    }
  });
});

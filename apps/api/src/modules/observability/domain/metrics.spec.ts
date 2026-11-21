import {
  applicationQueries,
  organizationQueries,
  organizationTotals,
  exposition,
  type Measures,
  nodeQueries,
  samples,
  validMeasures,
} from './metrics';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-000000000001';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-000000000002';
const APP = '0190f5a8-7b1c-7e2d-8f3a-000000000003';
const PROJECT = '0190f5a8-7b1c-7e2d-8f3a-000000000004';
const ENV = '0190f5a8-7b1c-7e2d-8f3a-000000000005';

const node = {
  cpuSeconds: 120.5,
  cpuCores: 4,
  memoryUsedBytes: 2e9,
  memoryTotalBytes: 8e9,
  diskUsedBytes: 1e10,
  diskTotalBytes: 5e10,
  networkReceivedBytes: 1000,
  networkSentBytes: 2000,
};
const container = {
  name: 'sk-shop-0123456789ab-r1-0',
  cpuSeconds: 3.5,
  memoryUsedBytes: 1e8,
  memoryLimitBytes: 5e8,
  networkReceivedBytes: 10,
  networkSentBytes: 20,
};
const host = {
  host: 'shop.example.com',
  responses2xx: 40,
  responses3xx: 1,
  responses4xx: 2,
  responses5xx: 3,
  responsesOther: 0,
  durationSeconds: 2.25,
};
const measures = (patch: Partial<Measures> = {}): Measures => ({
  node,
  containers: [container],
  hosts: [host],
  ...patch,
});
const workload = { projectId: PROJECT, environmentId: ENV, applicationId: APP };

describe('validMeasures', () => {
  it('accepts a report within its bounds', () => {
    expect(validMeasures(measures())).toBeDefined();
    // A counter only grows: past a petabyte it is still a real measure.
    expect(
      validMeasures(measures({ node: { ...node, networkReceivedBytes: 1_000_000_000_000_001 } })),
    ).toBeDefined();
    expect(validMeasures(measures({ node: undefined, containers: [], hosts: [] }))).toBeDefined();
  });

  it.each([
    ['a negative value', measures({ node: { ...node, cpuSeconds: -1 } })],
    ['an infinite value', measures({ node: { ...node, memoryUsedBytes: Infinity } })],
    ['not a number', measures({ node: { ...node, diskUsedBytes: Number.NaN } })],
    ['an absurd gauge', measures({ node: { ...node, memoryUsedBytes: 2e15 } })],
    ['an absurd counter', measures({ node: { ...node, networkSentBytes: 1e300 } })],
    [
      'a counter past exact integers',
      measures({ containers: [{ ...container, networkReceivedBytes: 2 ** 53 }] }),
    ],
    [
      'a container name that is not Shipkeep',
      measures({ containers: [{ ...container, name: '../etc/passwd' }] }),
    ],
    ['an injected host', measures({ hosts: [{ ...host, host: 'shop.example.com"} 1\nx{a="' }] })],
    ['an uppercase host', measures({ hosts: [{ ...host, host: 'Shop.example.com' }] })],
    ['an empty label', measures({ hosts: [{ ...host, host: 'a..example.com' }] })],
    [
      'more containers than an agent sends',
      measures({ containers: Array.from({ length: 257 }, () => container) }),
    ],
    ['more hosts than an agent sends', measures({ hosts: Array.from({ length: 65 }, () => host) })],
  ])('refuses the whole report for %s', (_, report) => {
    expect(validMeasures(report)).toBeUndefined();
  });
});

describe('samples', () => {
  it('labels every sample from the node and the targets the control plane found', () => {
    const out = samples(
      measures(),
      { organizationId: ORG, nodeId: NODE },
      [{ container: 'sk-shop-0123456789ab-r1-0', replica: 1, ...workload }],
      [{ hostname: 'shop.example.com', ...workload }],
    );
    const container = out.find((sample) => sample.name === 'shipkeep_container_cpu_seconds_total');
    expect(container).toEqual({
      name: 'shipkeep_container_cpu_seconds_total',
      labels: {
        organization_id: ORG,
        node_id: NODE,
        project_id: PROJECT,
        environment_id: ENV,
        application_id: APP,
        replica: '1',
        container: 'sk-shop-0123456789ab-r1-0',
      },
      value: 3.5,
    });
    const fiveXX = out.find(
      (sample) =>
        sample.name === 'shipkeep_route_responses_total' && sample.labels['status'] === '5xx',
    );
    expect(fiveXX?.labels).toMatchObject({ domain: 'shop.example.com', application_id: APP });
    expect(fiveXX?.value).toBe(3);
    expect(out.filter((sample) => sample.name.startsWith('shipkeep_node_'))).toHaveLength(8);
  });

  it('drops containers and hosts the node does not run', () => {
    const out = samples(measures(), { organizationId: ORG, nodeId: NODE }, [], []);
    expect(out.every((sample) => sample.name.startsWith('shipkeep_node_'))).toBe(true);
  });
});

describe('exposition', () => {
  it('writes one line per sample with its time, labels sorted and escaped', () => {
    const text = exposition(
      [{ name: 'shipkeep_x', labels: { b: 'a"b\\c\nd', a: 'v' }, value: 1.5 }],
      new Date(1_795_000_000_000),
    );
    expect(text).toBe('shipkeep_x{a="v",b="a\\"b\\\\c\\nd"} 1.5 1795000000000\n');
  });
});

describe('queries', () => {
  it('filter on the identifiers given, with a rate window of at least two samples', () => {
    const queries = applicationQueries(ORG, APP, '1h');
    expect(queries.cpu).toBe(
      `sum(rate(shipkeep_container_cpu_seconds_total{organization_id="${ORG}",application_id="${APP}"}[120s]))`,
    );
    expect(nodeQueries(ORG, NODE, '7d').cpu).toContain('[1800s]');
  });

  it('cover the whole organization, or only the environments given', () => {
    expect(organizationQueries(ORG, null, '30d').requests).toBe(
      `sum by (status) (rate(shipkeep_route_responses_total{organization_id="${ORG}"}[10800s]))`,
    );
    expect(organizationQueries(ORG, [ENV, APP], '24h').duration).toContain(
      `{organization_id="${ORG}",environment_id=~"${ENV}|${APP}"}[300s]`,
    );
    expect(() => organizationQueries(ORG, [], '24h')).toThrow();
    expect(() =>
      organizationQueries(
        ORG,
        Array.from({ length: 101 }, () => ENV),
        '24h',
      ),
    ).toThrow();
    expect(() => organizationQueries(ORG, [`${ENV}"} or vector(1) #`], '24h')).toThrow();
    expect(() => organizationQueries(ORG, ['.*'], '24h')).toThrow();
  });

  it('total the whole period at its end, under the same filters', () => {
    expect(organizationTotals(ORG, [ENV], '7d')).toEqual({
      requests: `sum(increase(shipkeep_route_responses_total{organization_id="${ORG}",environment_id=~"${ENV}"}[604800s]))`,
      seconds: `sum(increase(shipkeep_route_duration_seconds_total{organization_id="${ORG}",environment_id=~"${ENV}"}[604800s]))`,
    });
    expect(() => organizationTotals(ORG, ['.*'], '7d')).toThrow();
  });

  it('refuse to build a query from anything but an identifier', () => {
    expect(() => applicationQueries(ORG, 'x"} or vector(1) #', '1h')).toThrow();
    expect(() => nodeQueries('*', NODE, '1h')).toThrow();
  });
});

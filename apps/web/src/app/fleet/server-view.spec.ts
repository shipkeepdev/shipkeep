import { type FleetNode, type NodeReplica } from './fleet-api';
import { serverView } from './server-view';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const NOW = Date.parse('2026-11-22T10:00:00Z');
const node: FleetNode = {
  id: '0190f5a8-7b1c-7e2d-8f3a-0000000000bb',
  name: 'edge-1',
  status: 'ready',
  labels: { region: 'par' },
  facts: {
    hostname: 'edge-1.example.com',
    os: 'Ubuntu',
    os_version: '24.04',
    architecture: 'x86_64',
    kernel_version: '6.8.0-48-generic',
    cpu_count: 4,
    memory_bytes: 8 * 2 ** 30,
    disk_bytes: 100 * 2 ** 30,
    disk_free_bytes: 10 * 2 ** 30,
    docker_version: '28.5.1',
    agent_version: '0.1.0-alpha.3',
  },
  publicAddresses: ['203.0.113.10'],
  leaseEpoch: 3,
  createdAt: '2026-11-06T09:00:00Z',
  lastHeartbeatAt: '2026-11-22T09:59:58Z',
};
const replica = (id: string, application: string, n = 0): NodeReplica => ({
  id,
  releaseId: '0190f5a8-7b1c-7e2d-8f3a-000000000r01',
  replica: n,
  container: `sk-${application}-0123456789ab-r1-${String(n)}`,
  cpuMillis: 250,
  memoryBytes: 256 * 2 ** 20,
  placedAt: '2026-11-21T09:00:00Z',
  application: { id: `app-${application}`, name: application },
  project: { id: 'p1', name: 'Shop' },
  environment: { id: 'e1', name: 'production' },
  state: 'running',
  stopReason: null,
  observedAt: '2026-11-22T09:59:30Z',
});

describe('server view (#264)', () => {
  it('reads capacity, the machine and what runs on it', () => {
    const view = serverView(
      ORG,
      node,
      {
        items: [replica('r1', 'web'), replica('r2', 'web', 1), replica('r3', 'worker')],
        truncated: false,
      },
      NOW,
    );
    expect(view.sub).toBe('edge-1.example.com · Ubuntu 24.04 · x86_64');
    expect(view.stats[0]?.value).toEqual({ t: '{n} core', count: { n: 4, other: '{n} cores' } });
    expect(view.stats.slice(1).map((s) => [s.label, s.value.values?.['v']])).toEqual([
      ['Memory', '8 GiB'],
      ['Disk', '90 %'],
      ['Replicas', '3'],
    ]);
    // 90 % of the disk used is a warning.
    expect(view.stats[2]?.color).toBe('oklch(0.80 0.12 80)');
    expect(view.stats[3]?.sub).toEqual({
      t: '{n} application',
      count: { n: 2, other: '{n} applications' },
    });
    expect(view.machine.find((f) => f.label === 'Placement labels')?.value).toBe('region=par');
    expect(view.machine.find((f) => f.label === 'Caddy')?.value).toBeNull();
    expect(view.agent[0]?.value).toEqual({ t: '{s} s ago', values: { s: 2 } });
    expect(view.rows[0]).toEqual({
      id: 'r1',
      application: 'web',
      place: 'Shop · production',
      link: ['/orgs', ORG, 'projects', 'p1', 'environments', 'e1', 'applications', 'app-web'],
      replica: 0,
      container: 'sk-web-0123456789ab-r1-0',
      cpu: '0.25',
      memory: '256 MiB',
      status: { label: 'running', color: 'oklch(0.78 0.13 155)' },
    });
  });

  it('says what a single machine keeps for the control plane', () => {
    const view = serverView(
      ORG,
      {
        ...node,
        facts: { ...node.facts, reserved_cpu_millis: 500, reserved_memory_bytes: 2 ** 30 },
      },
      { items: [], truncated: false },
      NOW,
    );
    expect(view.stats[0]?.sub).toEqual({
      t: '{cpu} reserved for the control plane',
      values: { cpu: '0.5' },
    });
    expect(view.stats[1]?.sub).toEqual({
      t: '{memory} reserved for the control plane',
      values: { memory: '1 GiB' },
    });
  });

  it('never invents what the agent did not report', () => {
    const view = serverView(
      ORG,
      { ...node, facts: {}, labels: {}, publicAddresses: [], lastHeartbeatAt: null },
      { items: [replica('r1', 'web')], truncated: true },
      NOW,
    );
    expect(view.sub).toBe('');
    expect(view.agentVersion).toBeNull();
    expect(view.stats.map((s) => s.value.values?.['v'])).toEqual(['—', '—', '—', '1+']);
    expect(view.stats[2]?.color).toBeUndefined();
    expect(view.machine.find((f) => f.label === 'Hostname')?.value).toBeNull();
    expect(view.machine.find((f) => f.label === 'Public addresses')).toMatchObject({
      value: null,
      none: 'None declared',
    });
    expect(view.agent[0]?.value).toEqual({ t: 'never' });
    expect(view.truncated).toBe(true);
  });

  it('shows the replica the agent stopped for its disk budget, and one not seen yet', () => {
    const view = serverView(
      ORG,
      node,
      {
        items: [
          { ...replica('r1', 'web'), state: 'exited', stopReason: 'disk_limit' },
          { ...replica('r2', 'api'), state: null, observedAt: null },
        ],
        truncated: false,
      },
      NOW,
    );
    expect(view.rows.map((row) => row.status?.label ?? null)).toEqual([
      'stopped: disk limit',
      null,
    ]);
  });
});

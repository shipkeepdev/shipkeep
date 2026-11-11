import type { DomainEvent } from '@shipkeep/domain';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { NodeRecord, NodeStatus } from '../domain/node';
import type { NodeIdentity } from '../domain/node-identity';

import { MemoryNodeStore } from './fakes.spec-helpers';
import { NodeLiveness } from './node-liveness';
import type { FleetTransaction } from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0123456789ac';

function setup(status: NodeStatus) {
  const nodes = new MemoryNodeStore();
  const node: NodeRecord = {
    id: NODE,
    organizationId: ORG,
    name: 'edge-1',
    status,
    labels: {},
    facts: {},
    publicAddresses: [],
    leaseEpoch: 1,
    createdAt: new Date(0),
    lastHeartbeatAt: null,
  };
  nodes.nodes.push(node);
  const published: DomainEvent[] = [];
  const events = {
    publish: (batch: DomainEvent[]) => {
      published.push(...batch);
      return Promise.resolve();
    },
  } as unknown as DomainEventBus;
  const transaction = {
    runTenant: <T>(_organizationId: string, work: () => Promise<T>) => work(),
  } as unknown as FleetTransaction;
  const identity: NodeIdentity = { organizationId: ORG, nodeId: NODE, serial: '01' };
  return { nodes, published, liveness: new NodeLiveness(nodes, transaction, events), identity };
}

describe('NodeLiveness', () => {
  const now = new Date('2026-11-05T12:00:00Z');

  it('makes an enrolling node ready once, auditing only the transition', async () => {
    const { nodes, published, liveness, identity } = setup('enrolling');
    await liveness.heartbeat(identity, now);
    await liveness.heartbeat(identity, new Date(now.getTime() + 10_000));
    expect(nodes.nodes[0]).toMatchObject({
      status: 'ready',
      lastHeartbeatAt: new Date(now.getTime() + 10_000),
    });
    expect(published.map((event) => [event.type, event.payload])).toEqual([
      ['fleet.node.ready', { from: 'enrolling' }],
    ]);
  });

  it('keeps draining and removed nodes as they are', async () => {
    const draining = setup('draining');
    await draining.liveness.heartbeat(draining.identity, now);
    expect(draining.nodes.nodes[0]).toMatchObject({ status: 'draining', lastHeartbeatAt: now });
    expect(draining.published).toEqual([]);

    const removed = setup('removed');
    await removed.liveness.heartbeat(removed.identity, now);
    expect(removed.nodes.nodes[0]).toMatchObject({ status: 'removed', lastHeartbeatAt: null });
    expect(removed.published).toEqual([]);
  });
});

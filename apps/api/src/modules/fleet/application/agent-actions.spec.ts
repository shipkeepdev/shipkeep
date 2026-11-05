import { create } from '@bufbuild/protobuf';
import type { DomainEvent } from '@shipkeep/domain';
import { ActionUpdateSchema, OperationState } from '@shipkeep/proto-ts';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type { AgentActionChange, AgentActionRecord } from '../domain/agent-action';
import type { NodeRecord } from '../domain/node';

import { AgentActions } from './agent-actions';
import { MemoryNodeStore } from './fakes.spec-helpers';
import type { AgentActionStore, FleetTransaction } from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0123456789ac';
const ACTION = '0190f5a8-7b1c-7e2d-8f3a-0123456789ad';

function setup() {
  const nodes = new MemoryNodeStore();
  const node: NodeRecord = {
    id: NODE,
    organizationId: ORG,
    name: 'edge-1',
    status: 'ready',
    labels: {},
    facts: { hostname: 'edge-1' },
    leaseEpoch: 1,
    createdAt: new Date(0),
    lastHeartbeatAt: null,
  };
  nodes.nodes.push(node);
  const record = { id: ACTION, organizationId: ORG, nodeId: NODE, kind: 'collect_facts' };
  const store = {
    apply: (_org: string, _node: string, _id: string, change: AgentActionChange) =>
      Promise.resolve({ ...record, ...change } as unknown as AgentActionRecord),
  } as unknown as AgentActionStore;
  const transaction = {
    runTenant: <T>(_organizationId: string, work: () => Promise<T>) => work(),
  } as unknown as FleetTransaction;
  const events = {
    publish: (_events: DomainEvent[]) => Promise.resolve(),
  } as unknown as DomainEventBus;
  return { nodes, actions: new AgentActions(store, nodes, transaction, events) };
}

describe('AgentActions.record', () => {
  it('refreshes node facts from a successful CollectFacts result, keeping capacity', async () => {
    const { nodes, actions } = setup();
    await actions.record(
      { organizationId: ORG, nodeId: NODE, serial: '01' },
      create(ActionUpdateSchema, {
        actionId: ACTION,
        state: OperationState.SUCCEEDED,
        result: {
          result: {
            case: 'facts',
            value: {
              hostname: 'edge-1',
              architecture: 'arm64',
              cpuCount: 8,
              memoryBytes: 16n << 30n,
            },
          },
        },
      }),
    );
    expect(nodes.nodes[0]?.facts).toEqual({
      hostname: 'edge-1',
      architecture: 'arm64',
      cpu_count: 8,
      memory_bytes: 17_179_869_184,
      disk_bytes: 0,
      disk_free_bytes: 0,
    });
  });

  it('ignores facts from an action that did not succeed', async () => {
    const { nodes, actions } = setup();
    await actions.record(
      { organizationId: ORG, nodeId: NODE, serial: '01' },
      create(ActionUpdateSchema, {
        actionId: ACTION,
        state: OperationState.RUNNING,
        result: { result: { case: 'facts', value: { cpuCount: 64 } } },
      }),
    );
    expect(nodes.nodes[0]?.facts).toEqual({ hostname: 'edge-1' });
  });
});

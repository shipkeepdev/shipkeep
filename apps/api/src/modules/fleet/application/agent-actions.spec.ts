import { create } from '@bufbuild/protobuf';
import { type DomainEvent, InvalidInputError } from '@shipkeep/domain';
import { ActionUpdateSchema, CollectFactsSchema, OperationState } from '@shipkeep/proto-ts';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import type {
  AgentActionChange,
  AgentActionEntry,
  AgentActionRecord,
} from '../domain/agent-action';
import type { NodeRecord } from '../domain/node';

import { AgentActions } from './agent-actions';
import { MemoryNodeStore } from './fakes.spec-helpers';
import type { AgentActionStore, FleetTransaction } from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0123456789ab';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0123456789ac';
const ACTION = '0190f5a8-7b1c-7e2d-8f3a-0123456789ad';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0123456789ae';
const DEPLOYMENT = '0190f5a8-7b1c-7e2d-8f3a-0123456789af';

function setup() {
  const nodes = new MemoryNodeStore();
  const node: NodeRecord = {
    id: NODE,
    organizationId: ORG,
    name: 'edge-1',
    status: 'ready',
    labels: {},
    facts: { hostname: 'edge-1' },
    publicAddresses: [],
    leaseEpoch: 1,
    createdAt: new Date(0),
    lastHeartbeatAt: null,
  };
  nodes.nodes.push(node);
  const record = { id: ACTION, organizationId: ORG, nodeId: NODE, kind: 'collect_facts' };
  const inserted: AgentActionRecord[] = [];
  const history: AgentActionEntry[] = [];
  const pages: unknown[][] = [];
  const store = {
    apply: (_org: string, _node: string, _id: string, change: AgentActionChange) =>
      Promise.resolve({ ...record, ...change } as unknown as AgentActionRecord),
    findByKey: () => Promise.resolve(undefined),
    insert: (row: AgentActionRecord) => {
      inserted.push(row);
      return Promise.resolve(true);
    },
    forApplication: (...args: unknown[]) => {
      pages.push(args);
      return Promise.resolve(history);
    },
  } as unknown as AgentActionStore;
  const transaction = {
    runTenant: <T>(_organizationId: string, work: () => Promise<T>) => work(),
  } as unknown as FleetTransaction;
  const events = {
    publish: (_events: DomainEvent[]) => Promise.resolve(),
  } as unknown as DomainEventBus;
  return {
    nodes,
    inserted,
    history,
    pages,
    actions: new AgentActions(store, nodes, transaction, events),
  };
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

describe('AgentActions.enqueue', () => {
  const NOW = new Date('2026-11-11T10:00:00Z');
  const input = {
    organizationId: ORG,
    nodeId: NODE,
    idempotencyKey: `d:${DEPLOYMENT}:pull`,
    action: { case: 'collectFacts' as const, value: create(CollectFactsSchema, {}) },
    deadline: new Date(NOW.getTime() + 60_000),
    actor: { kind: 'system' as const },
  };

  it('records the deployment that requested the action', async () => {
    const { inserted, actions } = setup();
    await actions.enqueue(
      { ...input, origin: { applicationId: APP, deploymentId: DEPLOYMENT } },
      NOW,
    );
    expect(inserted[0]).toMatchObject({ applicationId: APP, deploymentId: DEPLOYMENT });
  });

  it('leaves the origin empty for actions outside a deployment', async () => {
    const { inserted, actions } = setup();
    await actions.enqueue(input, NOW);
    expect(inserted[0]).toMatchObject({ applicationId: null, deploymentId: null });
  });

  it('refuses a malformed origin', async () => {
    const { inserted, actions } = setup();
    for (const origin of [
      { applicationId: "x' OR '1'='1", deploymentId: DEPLOYMENT },
      { applicationId: APP, deploymentId: '../deployments' },
      { applicationId: APP, deploymentId: 'a'.repeat(4096) },
    ])
      await expect(actions.enqueue({ ...input, origin }, NOW)).rejects.toThrow(InvalidInputError);
    expect(inserted).toHaveLength(0);
  });
});

describe('AgentActions.history', () => {
  const entry: AgentActionEntry = {
    id: ACTION,
    nodeId: NODE,
    nodeName: 'edge-1',
    kind: 'pullImage',
    state: 'failed',
    step: '',
    attempts: 0,
    result: { releaseTask: { outputTail: 'DATABASE_URL=postgres://u:p@db' } },
    error: 'stale lease epoch',
    applicationId: APP,
    deploymentId: DEPLOYMENT,
    createdAt: new Date(0),
    updatedAt: new Date(1),
    completedAt: new Date(1),
  };

  it('replaces the raw result and error with their summary', async () => {
    const { history, pages, actions } = setup();
    history.push(entry);
    const views = await actions.history(ORG, APP, undefined, 51);
    const view = views[0];
    expect(pages).toEqual([[ORG, APP, undefined, 51]]);
    expect(view.summary).toEqual({
      outcome: 'refused',
      reason: 'stale_lease_epoch',
      result: null,
    });
    expect(view).not.toHaveProperty('result');
    expect(view).not.toHaveProperty('error');
    expect(JSON.stringify(view)).not.toContain('postgres://');
  });

  it('refuses malformed pages before reading', async () => {
    const { pages, actions } = setup();
    await expect(actions.history(ORG, 'not-a-uuid', undefined, 10)).rejects.toThrow(
      InvalidInputError,
    );
    await expect(actions.history(ORG, APP, "' OR 1=1 --", 10)).rejects.toThrow(InvalidInputError);
    await expect(actions.history(ORG, APP, undefined, 0)).rejects.toThrow(InvalidInputError);
    await expect(actions.history(ORG, APP, undefined, 102)).rejects.toThrow(InvalidInputError);
    expect(pages).toHaveLength(0);
  });
});

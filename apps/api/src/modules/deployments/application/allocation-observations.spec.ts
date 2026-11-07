import { create } from '@bufbuild/protobuf';
import type { DomainEvent } from '@shipkeep/domain';
import { ContainerStatus_State, StateReportSchema } from '@shipkeep/proto-ts';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { StateReports } from '../../fleet/application/state-reports';
import type { ObservationChange, ObservedAllocation } from '../domain/observations';

import { AllocationObservations, reportedContainers } from './allocation-observations';
import type { DeploymentTransaction, ObservationStore } from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const identity = { organizationId: ORG, nodeId: NODE, serial: '01' };
const NOW = new Date('2026-11-07T12:00:00Z');
const ID = 'f'.repeat(64);
const report = (
  containers: { containerId?: string; name?: string; state?: ContainerStatus_State }[],
) =>
  create(StateReportSchema, {
    containers: containers.map((container) => ({
      containerId: ID,
      name: 'sk-web-1',
      state: ContainerStatus_State.RUNNING,
      ...container,
    })),
  });

function setup(allocations: ObservedAllocation[]) {
  const applied: ObservationChange[][] = [];
  const events: DomainEvent[] = [];
  const nodes: string[] = [];
  const store: ObservationStore = {
    forApplication: () => Promise.resolve([]),
    placedOnNode: (_organization, nodeId) => {
      nodes.push(nodeId);
      return Promise.resolve(allocations);
    },
    apply: (_organization, changes) => {
      applied.push([...changes]);
      return Promise.resolve();
    },
  };
  const transaction: DeploymentTransaction = { runTenant: (_org, work) => work() };
  const bus = {
    publish: (batch: DomainEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  } as unknown as DomainEventBus;
  const registry = new StateReports();
  const service = new AllocationObservations(store, transaction, registry, bus);
  return { service, registry, applied, events, nodes };
}
const placed = (observation: ObservedAllocation['observation']): ObservedAllocation => ({
  id: 'a1',
  applicationId: 'app',
  environmentId: 'env',
  container: 'sk-web-1',
  observation,
});

describe('AllocationObservations', () => {
  it('records a state change for the reporting node and audits it as that node', async () => {
    const { service, applied, events, nodes } = setup([placed(null)]);
    await service.record(identity, report([{}]), NOW);
    expect(nodes).toEqual([NODE]);
    expect(applied[0]).toMatchObject([{ allocationId: 'a1', state: 'running', from: null }]);
    expect(events.map((event) => [event.type, event.actor, event.payload])).toEqual([
      [
        'allocation.observed',
        { kind: 'node', id: NODE },
        {
          applicationId: 'app',
          environmentId: 'env',
          nodeId: NODE,
          container: 'sk-web-1',
          from: null,
          to: 'running',
        },
      ],
    ]);
  });

  it('refreshes an unchanged observation without an audit event', async () => {
    const stale = placed({ state: 'running', observedAt: new Date(NOW.getTime() - 60_000) });
    const { service, applied, events } = setup([stale]);
    await service.record(identity, report([{}]), NOW);
    expect(applied).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('ignores a whole report with any invalid container, keeping the last good state', async () => {
    const { service, applied, nodes } = setup([placed({ state: 'running', observedAt: NOW })]);
    for (const bad of [
      report([{ name: '../../etc/passwd' }]),
      report([{ containerId: 'short' }]),
      report([{ state: ContainerStatus_State.UNSPECIFIED }]),
      report([{}, {}]),
      report(Array.from({ length: 257 }, (_, i) => ({ name: `sk-${String(i)}` }))),
    ]) {
      expect(reportedContainers(bad)).toBeUndefined();
      await service.record(identity, bad, NOW);
    }
    expect(nodes).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('receives reports through the fleet registry', async () => {
    const { service, registry, nodes } = setup([]);
    await registry.deliver(identity, report([]));
    expect(nodes).toEqual([]);
    service.onModuleInit();
    await registry.deliver(identity, report([]));
    expect(nodes).toEqual([NODE]);
  });
});

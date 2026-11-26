import { create } from '@bufbuild/protobuf';
import type { DomainEvent } from '@shipkeep/domain';
import { ContainerStatus_State, StateReportSchema } from '@shipkeep/proto-ts';

import type { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { StateReports } from '../../fleet/application/state-reports';
import type { ObservationChange, ObservedAllocation } from '../domain/observations';
import type { UnmatchedContainer } from '../domain/untracked-containers';

import { AllocationObservations, reportedContainers } from './allocation-observations';
import type { DeploymentTransaction, ObservationStore } from './ports';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const NODE = '0190f5a8-7b1c-7e2d-8f3a-0000000000bb';
const identity = { organizationId: ORG, nodeId: NODE, serial: '01' };
const NOW = new Date('2026-11-07T12:00:00Z');
const ID = 'f'.repeat(64);
const report = (
  containers: {
    containerId?: string;
    name?: string;
    state?: ContainerStatus_State;
    stopReason?: string;
  }[],
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
  let unmatched: UnmatchedContainer[] = [];
  const replaced: string[][] = [];
  const store: ObservationStore = {
    forApplication: () => Promise.resolve([]),
    onNode: () => Promise.resolve([]),
    unmatchedOnNode: () => Promise.resolve(unmatched),
    replaceUnmatched: (_organization, _node, containers, now) => {
      unmatched = containers.map(({ name, containerId, state }) => ({
        name,
        containerId,
        state,
        observedAt: now,
      }));
      replaced.push(containers.map((container) => container.name));
      return Promise.resolve();
    },
    owningApplications: () => Promise.resolve([]),
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
  return { service, registry, applied, events, nodes, replaced };
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
          stopReason: null,
        },
      ],
    ]);
  });

  it('refreshes an unchanged observation without an audit event', async () => {
    const stale = placed({
      state: 'running',
      stopReason: null,
      observedAt: new Date(NOW.getTime() - 60_000),
    });
    const { service, applied, events } = setup([stale]);
    await service.record(identity, report([{}]), NOW);
    expect(applied).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('records why the agent stopped a replica, and audits it (ADR 0022)', async () => {
    const { service, applied, events } = setup([
      placed({ state: 'running', stopReason: null, observedAt: NOW }),
    ]);
    await service.record(
      identity,
      report([{ state: ContainerStatus_State.EXITED, stopReason: 'disk_limit' }]),
      NOW,
    );
    expect(applied).toMatchObject([[{ state: 'exited', stopReason: 'disk_limit' }]]);
    expect(events.map((event) => event.payload)).toMatchObject([
      { from: 'running', to: 'exited', stopReason: 'disk_limit' },
    ]);
  });

  it('keeps a report whose stop reason it does not know, without the reason', async () => {
    const { service, applied, events } = setup([
      placed({ state: 'running', stopReason: null, observedAt: NOW }),
    ]);
    await service.record(
      identity,
      report([{ state: ContainerStatus_State.EXITED, stopReason: 'something_newer' }]),
      NOW,
    );
    expect(applied).toMatchObject([[{ state: 'exited', stopReason: null }]]);
    expect(JSON.stringify(events)).not.toContain('something_newer');
  });

  it('drops a stop reason paired with a state that is not stopped', async () => {
    const { service, applied } = setup([
      placed({ state: 'running', stopReason: null, observedAt: NOW }),
    ]);
    await service.record(
      identity,
      report([{ state: ContainerStatus_State.RUNNING, stopReason: 'disk_limit' }]),
      new Date(NOW.getTime() + 120_000),
    );
    expect(applied).toMatchObject([[{ state: 'running', stopReason: null }]]);
  });

  it('carries a cleared stop reason as null in the event', async () => {
    const { service, events } = setup([
      placed({ state: 'exited', stopReason: 'disk_limit', observedAt: NOW }),
    ]);
    await service.record(identity, report([{ state: ContainerStatus_State.RUNNING }]), NOW);
    expect(events.map((event) => event.payload)).toMatchObject([
      { from: 'exited', to: 'running', stopReason: null },
    ]);
  });

  it('ignores a whole report with any invalid container, keeping the last good state', async () => {
    const { service, applied, nodes } = setup([
      placed({ state: 'running', stopReason: null, observedAt: NOW }),
    ]);
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
  // #501: what matches no placed replica is kept for the server's page, written and audited only
  // when the set changes.
  it('keeps the containers that match no placed replica, and audits each change once', async () => {
    const { service, events, replaced } = setup([placed(null)]);
    const lost = 'sk-web-00000000a1b2-r2-0';
    await service.record(identity, report([{}, { name: lost, containerId: 'e'.repeat(64) }]), NOW);
    await service.record(identity, report([{}, { name: lost, containerId: 'e'.repeat(64) }]), NOW);
    expect(replaced).toEqual([[lost]]);
    const changed = events.filter((event) => event.type === 'node.unmatched_containers_changed');
    expect(changed.map((event) => [event.actor, event.target, event.payload])).toEqual([
      [
        { kind: 'node', id: NODE },
        { type: 'node', id: NODE },
        { added: [lost], gone: [], count: 1 },
      ],
    ]);
    // The container was removed: the set empties once.
    await service.record(identity, report([{}]), NOW);
    expect(replaced).toEqual([[lost], []]);
    expect(
      events
        .filter((event) => event.type === 'node.unmatched_containers_changed')
        .map((event) => event.payload),
    ).toEqual([
      { added: [lost], gone: [], count: 1 },
      { added: [], gone: [lost], count: 0 },
    ]);
  });

  it('keeps nothing from an invalid report', async () => {
    const { service, replaced } = setup([placed(null)]);
    await service.record(identity, report([{ name: 'not a name' }]), NOW);
    expect(replaced).toEqual([]);
  });
});

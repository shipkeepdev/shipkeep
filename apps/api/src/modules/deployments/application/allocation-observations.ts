import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createEvent } from '@shipkeep/domain';
import { ContainerStatus_State, type StateReport } from '@shipkeep/proto-ts';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { StateReports } from '../../fleet/application/state-reports';
import type { NodeIdentity } from '../../fleet/domain/node-identity';
import { observationChanges, type ReportedContainer } from '../domain/observations';

import {
  DEPLOYMENT_TRANSACTION,
  type DeploymentTransaction,
  OBSERVATION_STORE,
  type ObservationStore,
} from './ports';

const MAX_CONTAINERS = 256;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const CONTAINER_NAME = /^sk-[a-z0-9-]{1,60}$/;
const STATES: Readonly<Partial<Record<ContainerStatus_State, ReportedContainer['state']>>> = {
  [ContainerStatus_State.CREATED]: 'created',
  [ContainerStatus_State.RUNNING]: 'running',
  [ContainerStatus_State.PAUSED]: 'paused',
  [ContainerStatus_State.RESTARTING]: 'restarting',
  [ContainerStatus_State.EXITED]: 'exited',
  [ContainerStatus_State.DEAD]: 'dead',
};

/** The report's containers, or undefined when any is invalid: never act on a partial report. */
export function reportedContainers(report: StateReport): ReportedContainer[] | undefined {
  if (report.containers.length > MAX_CONTAINERS) return undefined;
  const names = new Set<string>();
  const containers: ReportedContainer[] = [];
  for (const container of report.containers) {
    const state = STATES[container.state];
    if (
      !state ||
      !CONTAINER_ID.test(container.containerId) ||
      !CONTAINER_NAME.test(container.name) ||
      names.has(container.name)
    )
      return undefined;
    names.add(container.name);
    containers.push({ containerId: container.containerId, name: container.name, state });
  }
  return containers;
}

/**
 * Records what agents observe for their own replicas (SPEC 3.5, PLAN M1.6b2). The identity comes
 * from the node's certificate, and only that node's placed allocations are read, so a report
 * cannot touch another node or organization. Observations never change scheduler reservations.
 */
@Injectable()
export class AllocationObservations implements OnModuleInit {
  private readonly logger = new Logger(AllocationObservations.name);

  constructor(
    @Inject(OBSERVATION_STORE) private readonly store: ObservationStore,
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    private readonly reports: StateReports,
    private readonly events: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.reports.register((identity, report) => this.record(identity, report));
  }

  async record(identity: NodeIdentity, report: StateReport, now = new Date()): Promise<void> {
    const containers = reportedContainers(report);
    if (!containers) {
      // The agent validates too, so this is a bug or a tampered agent. Keep the last good state.
      this.logger.warn({ nodeId: identity.nodeId }, 'invalid state report ignored');
      return;
    }
    await this.transaction.runTenant(identity.organizationId, async () => {
      const allocations = await this.store.placedOnNode(identity.organizationId, identity.nodeId);
      const changes = observationChanges(allocations, containers, now);
      if (!changes.length) return;
      await this.store.apply(identity.organizationId, changes, now);
      const events = changes
        .filter((change) => change.changed)
        .map((change) =>
          createEvent({
            type: 'allocation.observed',
            organizationId: identity.organizationId,
            actor: { kind: 'node', id: identity.nodeId },
            target: { type: 'allocation', id: change.allocationId },
            payload: {
              applicationId: change.applicationId,
              nodeId: identity.nodeId,
              container: change.container,
              from: change.from,
              to: change.state,
            },
            occurredAt: now,
          }),
        );
      if (events.length) await this.events.publish(events);
    });
  }
}

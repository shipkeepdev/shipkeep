import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ObservationStore } from '../application/ports';
import {
  OBSERVED_STATES,
  type ObservationChange,
  type ObservedAllocation,
  type ObservedState,
  type ReplicaStatus,
} from '../domain/observations';

@Injectable()
export class PrismaObservationStore implements ObservationStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async placedOnNode(organizationId: string, nodeId: string): Promise<ObservedAllocation[]> {
    const rows = await this.database.client.allocation.findMany({
      where: { organizationId, nodeId, state: 'placed' },
      include: { observation: true, application: { select: { environmentId: true } } },
    });
    return rows.map((row) => ({
      id: row.id,
      applicationId: row.applicationId,
      environmentId: row.application.environmentId,
      container: row.container,
      observation: row.observation
        ? { state: observedState(row.observation.state), observedAt: row.observation.observedAt }
        : null,
    }));
  }

  async forApplication(applicationId: string): Promise<ReplicaStatus[]> {
    const rows = await this.database.client.allocation.findMany({
      where: { applicationId, state: 'placed' },
      include: { observation: true, node: { select: { name: true } } },
      orderBy: [{ releaseId: 'desc' }, { replica: 'asc' }],
      take: 200,
    });
    return rows.map(replica);
  }

  async apply(
    organizationId: string,
    changes: readonly ObservationChange[],
    now: Date,
  ): Promise<void> {
    for (const change of changes) {
      const data = { containerId: change.containerId, state: change.state, observedAt: now };
      await this.database.client.allocationObservation.upsert({
        where: { allocationId: change.allocationId },
        create: { allocationId: change.allocationId, organizationId, ...data },
        update: data,
      });
    }
  }
}

function replica(row: {
  id: string;
  releaseId: string;
  replica: number;
  nodeId: string;
  container: string;
  node: { name: string };
  observation: { state: string; observedAt: Date } | null;
}): ReplicaStatus {
  return {
    id: row.id,
    releaseId: row.releaseId,
    replica: row.replica,
    nodeId: row.nodeId,
    nodeName: row.node.name,
    container: row.container,
    state: row.observation ? observedState(row.observation.state) : null,
    observedAt: row.observation?.observedAt ?? null,
  };
}

function observedState(value: string): ObservedState {
  return OBSERVED_STATES.find((state) => state === value) ?? 'missing';
}

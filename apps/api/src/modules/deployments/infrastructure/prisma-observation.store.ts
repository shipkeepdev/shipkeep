import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ObservationStore } from '../application/ports';
import {
  type NodeReplica,
  OBSERVED_STATES,
  type ObservationChange,
  type ObservedAllocation,
  type ObservedState,
  type ReplicaStatus,
  stopReason,
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
        ? {
            state: observedState(row.observation.state),
            stopReason: stopReason(row.observation.stopReason ?? ''),
            observedAt: row.observation.observedAt,
          }
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

  async onNode(
    organizationId: string,
    nodeId: string,
    limit: number,
  ): Promise<NodeReplica[] | undefined> {
    const node = await this.database.client.node.findFirst({
      where: { organizationId, id: nodeId },
      select: { id: true },
    });
    if (!node) return undefined;
    const rows = await this.database.client.allocation.findMany({
      where: { organizationId, nodeId, state: 'placed' },
      include: {
        observation: true,
        application: {
          select: {
            id: true,
            name: true,
            environment: {
              select: { id: true, name: true, project: { select: { id: true, name: true } } },
            },
          },
        },
      },
      orderBy: [{ application: { name: 'asc' } }, { replica: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      releaseId: row.releaseId,
      replica: row.replica,
      container: row.container,
      cpuMillis: row.cpuMillis,
      memoryBytes: Number(row.memoryBytes),
      placedAt: row.createdAt,
      application: { id: row.application.id, name: row.application.name },
      project: { ...row.application.environment.project },
      environment: { id: row.application.environment.id, name: row.application.environment.name },
      state: row.observation ? observedState(row.observation.state) : null,
      stopReason: row.observation ? stopReason(row.observation.stopReason ?? '') : null,
      observedAt: row.observation?.observedAt ?? null,
    }));
  }

  async apply(
    organizationId: string,
    changes: readonly ObservationChange[],
    now: Date,
  ): Promise<void> {
    for (const change of changes) {
      const data = {
        containerId: change.containerId,
        state: change.state,
        stopReason: change.stopReason,
        observedAt: now,
      };
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
  observation: { state: string; stopReason: string | null; observedAt: Date } | null;
}): ReplicaStatus {
  return {
    id: row.id,
    releaseId: row.releaseId,
    replica: row.replica,
    nodeId: row.nodeId,
    nodeName: row.node.name,
    container: row.container,
    state: row.observation ? observedState(row.observation.state) : null,
    stopReason: row.observation ? stopReason(row.observation.stopReason ?? '') : null,
    observedAt: row.observation?.observedAt ?? null,
  };
}

function observedState(value: string): ObservedState {
  return OBSERVED_STATES.find((state) => state === value) ?? 'missing';
}

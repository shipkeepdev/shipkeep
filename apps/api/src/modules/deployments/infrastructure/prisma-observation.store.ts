import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ObservationStore } from '../application/ports';
import {
  type NodeReplica,
  OBSERVED_STATES,
  type ObservationChange,
  type ObservedAllocation,
  type ObservedState,
  type ReplicaStatus,
  type ReportedContainer,
  stopReason,
} from '../domain/observations';
import type { OwningApplication, UnmatchedContainer } from '../domain/untracked-containers';

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

  async unmatchedOnNode(organizationId: string, nodeId: string): Promise<UnmatchedContainer[]> {
    const rows = await this.database.client.unmatchedContainer.findMany({
      where: { organizationId, nodeId },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => ({
      name: row.name,
      containerId: row.containerId,
      state: reportedState(row.state),
      observedAt: row.observedAt,
    }));
  }

  async replaceUnmatched(
    organizationId: string,
    nodeId: string,
    containers: readonly ReportedContainer[],
    now: Date,
  ): Promise<void> {
    await this.database.client.unmatchedContainer.deleteMany({ where: { organizationId, nodeId } });
    if (!containers.length) return;
    await this.database.client.unmatchedContainer.createMany({
      data: containers.map((container) => ({
        organizationId,
        nodeId,
        name: container.name,
        containerId: container.containerId,
        state: container.state,
        observedAt: now,
      })),
    });
  }

  async owningApplications(
    organizationId: string,
    suffixes: readonly string[],
  ): Promise<OwningApplication[]> {
    if (!suffixes.length) return [];
    // The pipeline names a container after the last 12 characters of its application's id.
    const rows = await this.database.client.$queryRaw<
      { id: string; name: string; project_id: string; environment_id: string; deploying: boolean }[]
    >`
      SELECT a.id::text, a.name, a.project_id::text, a.environment_id::text,
             EXISTS (
               SELECT 1 FROM deployments d
               WHERE d.application_id = a.id
                 AND d.state NOT IN ('succeeded', 'failed', 'cancelled', 'rolled_back')
             ) AS deploying
      FROM applications a
      WHERE a.organization_id = ${organizationId}::uuid
        AND right(a.id::text, 12) IN (${Prisma.join([...suffixes])})`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      environmentId: row.environment_id,
      deploying: row.deploying,
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

/** A stored unmatched container's state; a value written by a later version reads as exited. */
function reportedState(value: string): Exclude<ObservedState, 'missing'> {
  const state = observedState(value);
  return state === 'missing' ? 'exited' : state;
}

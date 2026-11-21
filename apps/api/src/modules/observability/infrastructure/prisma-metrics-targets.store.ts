import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { MetricsTargets } from '../application/ports';
import type { ContainerTarget, HostTarget } from '../domain/metrics';

@Injectable()
export class PrismaMetricsTargets implements MetricsTargets {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async onNode(
    organizationId: string,
    nodeId: string,
    containers: readonly string[],
    hosts: readonly string[],
  ): Promise<{ containers: ContainerTarget[]; hosts: HostTarget[] }> {
    const placed = await this.database.client.allocation.findMany({
      where: { organizationId, nodeId, state: 'placed', container: { in: [...containers] } },
      select: {
        container: true,
        replica: true,
        applicationId: true,
        application: { select: { projectId: true, environmentId: true } },
      },
    });
    // A domain counts only when its application is placed on this node: a node never reports
    // traffic for a workload of another node (ADR 0024).
    const domains = hosts.length
      ? await this.database.client.domain.findMany({
          where: {
            organizationId,
            hostname: { in: [...hosts] },
            application: { allocations: { some: { organizationId, nodeId, state: 'placed' } } },
          },
          select: {
            hostname: true,
            applicationId: true,
            application: { select: { projectId: true, environmentId: true } },
          },
        })
      : [];
    return {
      containers: placed.map((row) => ({
        container: row.container,
        replica: row.replica,
        applicationId: row.applicationId,
        projectId: row.application.projectId,
        environmentId: row.application.environmentId,
      })),
      hosts: domains.map((row) => ({
        hostname: row.hostname,
        applicationId: row.applicationId,
        projectId: row.application.projectId,
        environmentId: row.application.environmentId,
      })),
    };
  }

  async nodeExists(organizationId: string, nodeId: string): Promise<boolean> {
    const node = await this.database.client.node.findFirst({
      where: { organizationId, id: nodeId },
      select: { id: true },
    });
    return node !== null;
  }
}

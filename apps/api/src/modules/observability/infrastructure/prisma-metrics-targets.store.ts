import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { MetricsTargets } from '../application/ports';
import type { BuildTarget } from '../domain/logs';
import type { ContainerTarget, HostTarget } from '../domain/metrics';

/** A deployment's step key, as the pipeline names its actions: `d:<deployment>:<step>`. */
const DEPLOYMENT_KEY = /^d:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;

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

  async buildsOnNode(
    organizationId: string,
    nodeId: string,
    actionIds: readonly string[],
  ): Promise<BuildTarget[]> {
    const actions = await this.database.client.agentAction.findMany({
      where: { organizationId, nodeId, kind: 'buildImage', id: { in: [...actionIds] } },
      select: { id: true, idempotencyKey: true },
    });
    const deploymentOf = new Map<string, string>();
    for (const action of actions) {
      const deployment = DEPLOYMENT_KEY.exec(action.idempotencyKey)?.[1];
      if (deployment) deploymentOf.set(action.id, deployment);
    }
    if (deploymentOf.size === 0) return [];
    const deployments = await this.database.client.deployment.findMany({
      where: { organizationId, id: { in: [...new Set(deploymentOf.values())] } },
      select: {
        id: true,
        applicationId: true,
        application: { select: { projectId: true, environmentId: true } },
      },
    });
    const byId = new Map(deployments.map((deployment) => [deployment.id, deployment]));
    return [...deploymentOf].flatMap(([actionId, deploymentId]) => {
      const deployment = byId.get(deploymentId);
      return deployment
        ? [
            {
              actionId,
              deploymentId,
              applicationId: deployment.applicationId,
              projectId: deployment.application.projectId,
              environmentId: deployment.application.environmentId,
            },
          ]
        : [];
    });
  }

  async nodeExists(organizationId: string, nodeId: string): Promise<boolean> {
    const node = await this.database.client.node.findFirst({
      where: { organizationId, id: nodeId },
      select: { id: true },
    });
    return node !== null;
  }

  environments(
    organizationId: string,
    limit: number,
    after?: string,
  ): Promise<readonly { readonly id: string; readonly projectId: string }[]> {
    return this.database.client.environment.findMany({
      where: { organizationId, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, projectId: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }
}

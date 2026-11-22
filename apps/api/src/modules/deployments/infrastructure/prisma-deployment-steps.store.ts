import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { DeploymentStepStore } from '../application/ports';
import { STEP_ACTIONS, type StepEvent } from '../domain/timeline';

/**
 * Reads a deployment's state changes back from the audit log, where every change is recorded
 * (CLAUDE.md rule 6): only the state actions, their metadata and time, never actors or addresses.
 */
@Injectable()
export class PrismaDeploymentSteps implements DeploymentStepStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async events(organizationId: string, deploymentId: string, limit: number): Promise<StepEvent[]> {
    const rows = await this.database.client.auditEvent.findMany({
      where: {
        organizationId,
        targetType: 'deployment',
        targetId: deploymentId,
        action: { in: [...STEP_ACTIONS] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { action: true, metadata: true, createdAt: true },
    });
    return rows.map((row) => ({ action: row.action, metadata: row.metadata, at: row.createdAt }));
  }
}

import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  environmentSettings,
  NotFoundError,
  projectSettings,
  type EnvironmentSettings,
  type ProjectSettings,
} from '@shipkeep/domain';

import { Prisma } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type {
  EnvironmentRecord,
  EnvironmentTarget,
  ProjectRecord,
  ProjectTarget,
  ResourceStore,
} from '../application/resource-store';

@Injectable()
export class PrismaResourceStore implements ResourceStore {
  constructor(private readonly database: PrismaUnitOfWork) {}
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runTenant(organizationId, operation);
  }
  async createProject(record: ProjectRecord): Promise<ProjectRecord> {
    const result = await this.database.client.project.createMany({
      data: record,
      skipDuplicates: true,
    });
    if (result.count !== 1) throw conflict('project');
    return record;
  }
  async updateProject(
    target: ProjectTarget,
    settings: ProjectSettings,
    now: Date,
  ): Promise<ProjectRecord> {
    return translateConflict('project', async () => {
      const rows = await this.database.client.project.updateManyAndReturn({
        where: { id: target.projectId, organizationId: target.organizationId },
        data: { ...settings, updatedAt: now },
      });
      const row = rows.at(0);
      if (!row) throw new NotFoundError('resource');
      return { ...row, ...projectSettings(row) };
    });
  }
  async createEnvironment(record: EnvironmentRecord): Promise<EnvironmentRecord> {
    const result = await this.database.client.environment.createMany({
      data: record,
      skipDuplicates: true,
    });
    if (result.count !== 1) throw conflict('environment');
    return record;
  }
  async updateEnvironment(
    target: EnvironmentTarget,
    settings: EnvironmentSettings,
    now: Date,
  ): Promise<EnvironmentRecord> {
    return translateConflict('environment', async () => {
      const rows = await this.database.client.environment.updateManyAndReturn({
        where: {
          id: target.environmentId,
          organizationId: target.organizationId,
          projectId: target.projectId,
        },
        data: { ...settings, updatedAt: now },
      });
      const row = rows.at(0);
      if (!row) throw new NotFoundError('resource');
      return { ...row, ...environmentSettings(row) };
    });
  }
}
async function translateConflict<T>(
  kind: 'project' | 'environment',
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw conflict(kind);
    throw error;
  }
}
function conflict(kind: 'project' | 'environment'): ConflictError {
  return new ConflictError(
    `${kind}_name_unavailable`,
    'Resource name is unavailable in this scope.',
  );
}

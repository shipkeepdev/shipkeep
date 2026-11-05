import { Injectable } from '@nestjs/common';
import { environmentSettings, projectSettings, RESOURCE_ROLES } from '@shipkeep/domain';

import type { Prisma } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { CatalogBounds, CatalogStore } from '../application/catalog-store';
import type { OrganizationRecord } from '../application/organization-store';
import type {
  EnvironmentRecord,
  EnvironmentTarget,
  ProjectRecord,
  ProjectTarget,
} from '../application/resource-store';

@Injectable()
export class PrismaCatalogStore implements CatalogStore {
  constructor(private readonly database: PrismaUnitOfWork) {}
  account<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runAccountDiscovery(userId, operation);
  }
  tenant<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runTenant(organizationId, operation);
  }
  organizations(userId: string, bounds: CatalogBounds): Promise<OrganizationRecord[]> {
    return this.database.client.organization.findMany({
      where: { ...cursor(bounds), memberships: { some: member(userId) } },
      orderBy: { id: 'desc' },
      take: bounds.limit,
    });
  }
  async projects(
    userId: string,
    organizationId: string,
    bounds: CatalogBounds,
  ): Promise<ProjectRecord[]> {
    const rows = await this.database.client.project.findMany({
      where: {
        organizationId,
        ...cursor(bounds),
        OR: [
          {
            organization: {
              memberships: { some: { ...member(userId), orgRole: { in: ['owner', 'admin'] } } },
            },
          },
          {
            roleBindings: {
              some: {
                organizationId,
                membership: member(userId),
                role: { in: [...RESOURCE_ROLES] },
              },
            },
          },
        ],
      },
      orderBy: { id: 'desc' },
      take: bounds.limit,
    });
    return rows.map((row) => ({ ...row, ...projectSettings(row) }));
  }
  async environments(
    userId: string,
    target: ProjectTarget,
    bounds: CatalogBounds,
  ): Promise<EnvironmentRecord[]> {
    const binding = {
      organizationId: target.organizationId,
      membership: member(userId),
      role: { in: [...RESOURCE_ROLES] },
    };
    const rows = await this.database.client.environment.findMany({
      where: {
        organizationId: target.organizationId,
        projectId: target.projectId,
        ...cursor(bounds),
        OR: [
          {
            organization: {
              memberships: { some: { ...member(userId), orgRole: { in: ['owner', 'admin'] } } },
            },
          },
          { project: { roleBindings: { some: { ...binding, environmentId: null } } } },
          { roleBindings: { some: binding } },
        ],
      },
      orderBy: { id: 'desc' },
      take: bounds.limit,
    });
    return rows.map((row) => ({ ...row, ...environmentSettings(row) }));
  }
  organization(id: string): Promise<OrganizationRecord | null> {
    return this.database.client.organization.findFirst({ where: { id } });
  }
  async project(target: ProjectTarget): Promise<ProjectRecord | null> {
    const row = await this.database.client.project.findFirst({
      where: { id: target.projectId, organizationId: target.organizationId },
    });
    return row ? { ...row, ...projectSettings(row) } : null;
  }
  async environment(target: EnvironmentTarget): Promise<EnvironmentRecord | null> {
    const row = await this.database.client.environment.findFirst({
      where: {
        id: target.environmentId,
        organizationId: target.organizationId,
        projectId: target.projectId,
      },
    });
    return row ? { ...row, ...environmentSettings(row) } : null;
  }
}
function member(userId: string): Prisma.MembershipWhereInput {
  return { userId, user: { status: 'active', emailVerifiedAt: { not: null } } };
}
function cursor(bounds: CatalogBounds): { id?: { lt: string } } {
  return bounds.cursor ? { id: { lt: bounds.cursor } } : {};
}

import { Injectable } from '@nestjs/common';
import type { ResourceContext } from '@shipkeep/domain';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { TenantAccessRecord, TenantAccessStore } from '../application/tenant-access-store';

@Injectable()
export class PrismaTenantAccessStore implements TenantAccessStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runTenant(organizationId, operation);
  }

  async resolve(
    userId: string,
    organizationId: string,
    target: ResourceContext,
  ): Promise<TenantAccessRecord | undefined> {
    const client = this.database.client;
    const member = await client.membership.findFirst({
      where: { organizationId, userId, user: { status: 'active', emailVerifiedAt: { not: null } } },
      select: { id: true, orgRole: true },
    });
    if (!member) return undefined;
    if (
      target.projectId &&
      !(await client.project.findFirst({
        where: { id: target.projectId, organizationId },
        select: { id: true },
      }))
    )
      return undefined;
    const environment = target.environmentId
      ? await client.environment.findFirst({
          where: { id: target.environmentId, organizationId, projectId: target.projectId },
          select: { id: true, protected: true },
        })
      : null;
    if (target.environmentId && !environment) return undefined;
    const bindings = target.projectId
      ? await client.roleBinding.findMany({
          where: {
            organizationId,
            membershipId: member.id,
            projectId: target.projectId,
            ...(target.environmentId
              ? { OR: [{ environmentId: null }, { environmentId: target.environmentId }] }
              : {}),
          },
          select: { projectId: true, environmentId: true, role: true },
          // One unique project grant plus one environment grant suffices for parent navigation.
          orderBy: { environmentId: { sort: 'asc', nulls: 'first' } },
          take: 2,
        })
      : [];
    return {
      membership: {
        organizationId,
        role: member.orgRole,
        bindings: bindings.map((binding) => ({
          projectId: binding.projectId,
          role: binding.role,
          ...(binding.environmentId ? { environmentId: binding.environmentId } : {}),
        })),
      },
      resource: {
        organizationId,
        ...(target.projectId ? { projectId: target.projectId } : {}),
        ...(environment ? { environmentId: environment.id, protected: environment.protected } : {}),
      },
    };
  }
}

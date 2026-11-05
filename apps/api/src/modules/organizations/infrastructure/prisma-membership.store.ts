import { Injectable } from '@nestjs/common';
import { NotFoundError, parseOrganizationRole, type OrganizationRole } from '@shipkeep/domain';

import type { Membership } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { MembershipRecord, MembershipStore } from '../application/membership-store';

@Injectable()
export class PrismaMembershipStore implements MembershipStore {
  constructor(private readonly database: PrismaUnitOfWork) {}
  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runTenant(organizationId, operation);
  }
  async lockOrganization(organizationId: string): Promise<void> {
    const rows = await this.database.client.$queryRaw<
      { id: string }[]
    >`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundError('resource');
  }
  async find(organizationId: string, id: string): Promise<MembershipRecord | null> {
    return record(
      await this.database.client.membership.findFirst({ where: { organizationId, id } }),
    );
  }
  async forUser(organizationId: string, userId: string): Promise<MembershipRecord | null> {
    return record(
      await this.database.client.membership.findFirst({ where: { organizationId, userId } }),
    );
  }
  ownerCount(organizationId: string): Promise<number> {
    return this.database.client.membership.count({ where: { organizationId, orgRole: 'owner' } });
  }
  async insert(member: MembershipRecord): Promise<void> {
    await this.database.client.membership.create({ data: member });
  }
  async setRole(
    organizationId: string,
    id: string,
    role: OrganizationRole,
    now: Date,
  ): Promise<MembershipRecord> {
    const rows = await this.database.client.membership.updateManyAndReturn({
      where: { organizationId, id },
      data: { orgRole: role, updatedAt: now },
    });
    const updated = record(rows.at(0) ?? null);
    if (!updated) throw new NotFoundError('resource');
    return updated;
  }
  async remove(organizationId: string, id: string): Promise<void> {
    await this.database.client.membership.deleteMany({ where: { organizationId, id } });
  }
}
function record(member: Membership | null): MembershipRecord | null {
  return member ? { ...member, orgRole: parseOrganizationRole(member.orgRole) } : null;
}

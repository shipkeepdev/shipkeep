import { Injectable } from '@nestjs/common';
import { parseResourceRole } from '@shipkeep/domain';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { BindingRecord, BindingStore, BindingTarget } from '../application/binding-store';

@Injectable()
export class PrismaBindingStore implements BindingStore {
  constructor(private readonly database: PrismaUnitOfWork) {}
  async find(target: BindingTarget, membershipId: string): Promise<BindingRecord | null> {
    const row = await this.database.client.roleBinding.findFirst({
      where: { ...scope(target), membershipId },
    });
    return row ? { ...row, role: parseResourceRole(row.role) } : null;
  }
  async save(record: BindingRecord): Promise<void> {
    await this.database.client.roleBinding.upsert({
      where: {
        id: record.id,
        organizationId: record.organizationId,
        projectId: record.projectId,
        environmentId: record.environmentId,
        membershipId: record.membershipId,
      },
      create: record,
      update: { role: record.role, updatedAt: record.updatedAt },
    });
  }
  async remove(target: BindingTarget, id: string): Promise<void> {
    await this.database.client.roleBinding.deleteMany({ where: { id, ...scope(target) } });
  }
}
function scope(target: BindingTarget) {
  return {
    organizationId: target.organizationId,
    projectId: target.projectId,
    environmentId: target.environmentId ?? null,
  };
}

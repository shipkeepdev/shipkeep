import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, type OrganizationSettings } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { Prisma } from '../../../platform/prisma/generated/client';
import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { OrganizationRecord, OrganizationStore } from '../application/organization-store';

@Injectable()
export class PrismaOrganizationStore implements OrganizationStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  transaction<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
    return this.database.runTenant(organizationId, operation);
  }

  async create(record: OrganizationRecord, ownerId: string): Promise<void> {
    const created = await this.database.client.organization.createMany({
      data: record,
      skipDuplicates: true,
    });
    if (created.count !== 1) throw slugConflict();
    await this.database.client.membership.create({
      data: {
        id: uuidv7(),
        organizationId: record.id,
        userId: ownerId,
        orgRole: 'owner',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    });
  }

  async update(id: string, settings: OrganizationSettings, now: Date): Promise<OrganizationRecord> {
    try {
      const records = await this.database.client.organization.updateManyAndReturn({
        where: { id },
        data: { name: settings.name, slug: settings.slug, updatedAt: now },
      });
      const record = records.at(0);
      if (!record) throw new NotFoundError('resource');
      return record;
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw slugConflict();
      throw error;
    }
  }
}

function slugConflict(): ConflictError {
  return new ConflictError('organization_slug_unavailable', 'Organization slug is unavailable.');
}

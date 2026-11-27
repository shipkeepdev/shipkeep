import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { RegistryGrant, RegistryGrantStore } from '../application/ports';

@Injectable()
export class PrismaRegistryGrantStore implements RegistryGrantStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async insert(grant: RegistryGrant): Promise<void> {
    await this.database.client.registryGrant.create({ data: { ...grant } });
  }

  async find(organizationId: string, grantId: string): Promise<RegistryGrant | undefined> {
    const row = await this.database.client.registryGrant.findFirst({
      where: { id: grantId, organizationId },
    });
    return row ?? undefined;
  }

  async removeExpired(organizationId: string, before: Date): Promise<number> {
    const removed = await this.database.client.registryGrant.deleteMany({
      where: { organizationId, expiresAt: { lt: before } },
    });
    return removed.count;
  }
}

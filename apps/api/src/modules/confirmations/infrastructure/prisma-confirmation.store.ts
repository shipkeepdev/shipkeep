import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { ConfirmationRecord, ConfirmationStore } from '../application/ports';
import type { ConfirmationRequest } from '../domain/confirmation-token';

@Injectable()
export class PrismaConfirmationStore implements ConfirmationStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async insert(record: ConfirmationRecord): Promise<void> {
    await this.database.client.confirmationToken.createMany({ data: { ...record } });
  }

  async consume(
    id: string,
    request: ConfirmationRequest,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    // One conditional update: concurrent consumers cannot both succeed.
    const result = await this.database.client.confirmationToken.updateMany({
      where: {
        id,
        organizationId: request.organizationId,
        action: request.action,
        target: request.target,
        userId,
        usedAt: null,
        expiresAt: { gt: now },
      },
      data: { usedAt: now },
    });
    return result.count === 1;
  }
}

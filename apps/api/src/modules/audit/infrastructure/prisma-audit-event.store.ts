import { Injectable } from '@nestjs/common';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { AuditEventStore } from '../application/audit-event-store';
import type { AuditRecord } from '../domain/audit-record';

/**
 * Append-only Prisma implementation. The runtime role may only SELECT and INSERT, and row
 * security hides events outside the active tenant, so the insert must not read the row back.
 */
@Injectable()
export class PrismaAuditEventStore implements AuditEventStore {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async append(record: AuditRecord): Promise<void> {
    // `createMany` issues no RETURNING clause, which row security would check as a read.
    await this.database.client.auditEvent.createMany({
      data: {
        id: record.id,
        organizationId: record.organizationId,
        actorKind: record.actorKind,
        actorId: record.actorId,
        ip: record.ip,
        action: record.action,
        targetType: record.targetType,
        targetId: record.targetId,
        metadata: record.metadata as Record<string, never>,
        createdAt: record.createdAt,
      },
    });
  }
}

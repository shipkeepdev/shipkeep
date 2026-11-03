import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../platform/prisma/prisma.service';
import type { AuditEventStore } from '../application/audit-event-store';
import type { AuditRecord } from '../domain/audit-record';

/** Append-only Prisma implementation. Database permissions enforce the rest in task M2.4. */
@Injectable()
export class PrismaAuditEventStore implements AuditEventStore {
  constructor(private readonly prisma: PrismaService) {}

  async append(record: AuditRecord): Promise<void> {
    await this.prisma.auditEvent.create({
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

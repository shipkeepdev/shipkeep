import { Injectable } from '@nestjs/common';
import type { ActorKind } from '@shipkeep/domain';

import { PrismaUnitOfWork } from '../../../platform/prisma/prisma-unit-of-work';
import type { AuditEventReader, AuditFilter } from '../application/audit-event-reader';
import type { AuditRecord } from '../domain/audit-record';

@Injectable()
export class PrismaAuditEventReader implements AuditEventReader {
  constructor(private readonly database: PrismaUnitOfWork) {}

  async page(
    organizationId: string,
    filter: AuditFilter,
    beforeId: string | undefined,
    limit: number,
  ): Promise<AuditRecord[]> {
    const rows = await this.database.runTenant(organizationId, () =>
      this.database.client.auditEvent.findMany({
        where: {
          organizationId,
          ...(filter.action ? { action: filter.action } : {}),
          ...(filter.targetType ? { targetType: filter.targetType } : {}),
          ...(filter.targetId ? { targetId: filter.targetId } : {}),
          ...(filter.actorId ? { actorId: filter.actorId } : {}),
          ...(filter.from || filter.to
            ? {
                createdAt: {
                  ...(filter.from ? { gte: filter.from } : {}),
                  ...(filter.to ? { lt: filter.to } : {}),
                },
              }
            : {}),
          ...(beforeId ? { id: { lt: beforeId } } : {}),
        },
        orderBy: { id: 'desc' },
        take: limit,
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      actorKind: row.actorKind as ActorKind,
      actorId: row.actorId,
      ip: row.ip,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.createdAt,
    }));
  }
}

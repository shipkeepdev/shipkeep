import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { TenantAccessModule } from '../organizations/tenant-access.module';

import { AUDIT_EVENT_READER } from './application/audit-event-reader';
import { AUDIT_EVENT_STORE } from './application/audit-event-store';
import { AuditQueries } from './application/audit-queries';
import { AuditRecorder } from './application/audit-recorder';
import { PrismaAuditEventReader } from './infrastructure/prisma-audit-event.reader';
import { PrismaAuditEventStore } from './infrastructure/prisma-audit-event.store';
import { AuditController } from './interface/audit.controller';

/**
 * Audit log: every domain event becomes an append-only record (CLAUDE.md, rule 6), readable by
 * its organization's administrators (PLAN M2.4a).
 */
@Module({
  imports: [IdentityModule, TenantAccessModule],
  controllers: [AuditController],
  providers: [
    { provide: AUDIT_EVENT_STORE, useClass: PrismaAuditEventStore },
    { provide: AUDIT_EVENT_READER, useClass: PrismaAuditEventReader },
    AuditRecorder,
    AuditQueries,
  ],
})
export class AuditModule {}

import { Module } from '@nestjs/common';

import { AUDIT_EVENT_STORE } from './application/audit-event-store';
import { AuditRecorder } from './application/audit-recorder';
import { PrismaAuditEventStore } from './infrastructure/prisma-audit-event.store';

/** Audit log: every domain event becomes an append-only record (CLAUDE.md, rule 6). */
@Module({
  providers: [{ provide: AUDIT_EVENT_STORE, useClass: PrismaAuditEventStore }, AuditRecorder],
})
export class AuditModule {}

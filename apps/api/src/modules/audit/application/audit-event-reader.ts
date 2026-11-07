import type { AuditRecord } from '../domain/audit-record';

export interface AuditFilter {
  readonly action?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly actorId?: string;
  /** Inclusive lower bound of `createdAt`. */
  readonly from?: Date;
  /** Exclusive upper bound of `createdAt`. */
  readonly to?: Date;
}

export const AUDIT_EVENT_READER = Symbol('AuditEventReader');
/** Reads one organization's audit events under its row security context (M2.3g2). */
export interface AuditEventReader {
  /** Newest first (UUIDv7 order), exclusive `beforeId` cursor, at most `limit` events. */
  page(
    organizationId: string,
    filter: AuditFilter,
    beforeId: string | undefined,
    limit: number,
  ): Promise<AuditRecord[]>;
  /** Oldest first (UUIDv7 order): events of one environment after an exclusive id cursor. */
  afterInEnvironment(
    organizationId: string,
    environmentId: string,
    afterId: string,
    limit: number,
  ): Promise<AuditRecord[]>;
}

import type { AuditRecord } from '../domain/audit-record';

/** Port for the append-only audit store. Deliberately has no update or delete operation. */
export interface AuditEventStore {
  append(record: AuditRecord): Promise<void>;
}

export const AUDIT_EVENT_STORE = Symbol('AuditEventStore');

import type { ActorKind, DomainEvent } from '@shipkeep/domain';

/**
 * One line of the audit log (SPEC section 4, `AuditEvent`). Records are derived from domain
 * events and are append-only: there is no update or delete path anywhere in the code.
 */
export interface AuditRecord {
  readonly id: string;
  readonly organizationId: string | null;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly ip: string | null;
  /** The event type, for example `organization.created`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

/** Maps a domain event to its audit record. `id` is assigned by the caller (UUIDv7). */
export function auditRecordFromEvent(event: DomainEvent, id: string): AuditRecord {
  return {
    id,
    organizationId: event.organizationId ?? null,
    actorKind: event.actor.kind,
    actorId: event.actor.id ?? null,
    ip: event.actor.ip ?? null,
    action: event.type,
    targetType: event.target.type,
    targetId: event.target.id,
    metadata: event.payload,
    createdAt: event.occurredAt,
  };
}

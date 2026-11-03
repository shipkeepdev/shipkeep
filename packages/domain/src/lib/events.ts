/** Who caused a state change (SPEC section 4, `AuditEvent.actor`). */
export type ActorKind = 'user' | 'api_token' | 'system' | 'node';

export interface Actor {
  readonly kind: ActorKind;
  /** Identifier of the user, token or node. Absent for `system`. */
  readonly id?: string;
  /** Client IP address when the change came through the API. */
  readonly ip?: string;
}

export const SYSTEM_ACTOR: Actor = { kind: 'system' };

/** The resource a change applies to. */
export interface EventTarget {
  readonly type: string;
  readonly id: string;
}

/**
 * A fact about a state change, produced by command handlers (CLAUDE.md, rule 6). The audit log
 * is built from these events, so every write path must emit at least one. `payload` holds
 * structured details safe to persist: never secret values, only their names and versions.
 */
export interface DomainEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  /** Dotted lowercase name, `<aggregate>.<verb>`, for example `organization.created`. */
  readonly type: string;
  readonly occurredAt: Date;
  /** Tenant scope. Absent only for installation-wide changes. */
  readonly organizationId?: string;
  readonly actor: Actor;
  readonly target: EventTarget;
  readonly payload: TPayload;
}

export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface CreateEventInput<TPayload extends Record<string, unknown>> {
  type: string;
  actor: Actor;
  target: EventTarget;
  payload: TPayload;
  organizationId?: string;
  occurredAt?: Date;
}

/** Builds an event, validating its type name. */
export function createEvent<TPayload extends Record<string, unknown>>(
  input: CreateEventInput<TPayload>,
): DomainEvent<TPayload> {
  if (!EVENT_TYPE_PATTERN.test(input.type)) {
    throw new TypeError(`invalid event type "${input.type}": expected <aggregate>.<verb>`);
  }
  if (input.target.type === '' || input.target.id === '') {
    throw new TypeError(`event ${input.type} has an empty target`);
  }
  return {
    type: input.type,
    occurredAt: input.occurredAt ?? new Date(),
    ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
    actor: input.actor,
    target: input.target,
    payload: input.payload,
  };
}

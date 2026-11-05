import { type Actor, createEvent, type DomainEvent } from '@shipkeep/domain';

export function identityEvent(
  action: string,
  userId: string,
  actor: Actor,
  occurredAt: Date,
): DomainEvent {
  return createEvent({
    type: `identity.${action}`,
    actor,
    target: { type: 'user', id: userId },
    payload: {},
    occurredAt,
  });
}

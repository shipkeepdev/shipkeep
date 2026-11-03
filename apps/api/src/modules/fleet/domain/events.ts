import { type Actor, createEvent, type DomainEvent } from '@shipkeep/domain';

export function joinTokenIssued(input: {
  organizationId: string;
  tokenId: string;
  expiresAt: Date;
  actor: Actor;
}): DomainEvent {
  return createEvent({
    type: 'fleet.join_token.issued',
    organizationId: input.organizationId,
    actor: input.actor,
    target: { type: 'join_token', id: input.tokenId },
    payload: { expiresAt: input.expiresAt.toISOString() },
  });
}

export function nodeEnrolled(input: {
  organizationId: string;
  nodeId: string;
  name: string;
  tokenId: string;
  certificateSerial: string;
  certificateNotAfter: Date;
  ip?: string;
}): DomainEvent {
  return createEvent({
    type: 'fleet.node.enrolled',
    organizationId: input.organizationId,
    actor: { kind: 'node', id: input.nodeId, ...(input.ip ? { ip: input.ip } : {}) },
    target: { type: 'node', id: input.nodeId },
    payload: {
      name: input.name,
      joinTokenId: input.tokenId,
      certificateSerial: input.certificateSerial,
      certificateNotAfter: input.certificateNotAfter.toISOString(),
    },
  });
}

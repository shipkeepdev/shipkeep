import { DomainError } from '@shipkeep/domain';

import type { NodeStatus } from './node';

/** Taken only from a TLS-verified certificate, never request headers or message fields. */
export interface NodeIdentity {
  organizationId: string;
  nodeId: string;
  serial: string;
}

export interface NodeCredential extends NodeIdentity {
  status: NodeStatus;
  leaseEpoch: number;
  notBefore: Date;
  notAfter: Date;
  revokedAt: Date | null;
}

export class NodeAuthenticationError extends DomainError {
  readonly kind = 'unauthorized' as const;
  readonly code = 'node_unauthenticated';
  constructor() {
    super('a current registered node certificate is required');
  }
}

export function authenticateCertificate(
  identity: NodeIdentity,
  credential: NodeCredential | undefined,
  now: Date,
): NodeCredential {
  if (
    !credential ||
    credential.organizationId !== identity.organizationId ||
    credential.nodeId !== identity.nodeId ||
    credential.serial !== identity.serial ||
    credential.status === 'removed' ||
    credential.revokedAt !== null ||
    credential.notBefore > now ||
    credential.notAfter <= now
  )
    throw new NodeAuthenticationError();
  return credential;
}

import { Inject, Injectable } from '@nestjs/common';
import { createEvent, InvalidInputError } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { NodeAuthenticationError, type NodeIdentity } from '../domain/node-identity';

import { AuthenticateNode } from './authenticate-node';
import {
  CERTIFICATE_AUTHORITY,
  type CertificateAuthority,
  FLEET_TRANSACTION,
  type FleetTransaction,
  NODE_CREDENTIAL_STORE,
  type NodeCredentialStore,
  type IssuedCertificate,
} from './ports';

@Injectable()
export class RenewNodeCertificate {
  constructor(
    private readonly authenticate: AuthenticateNode,
    @Inject(CERTIFICATE_AUTHORITY) private readonly ca: CertificateAuthority,
    @Inject(NODE_CREDENTIAL_STORE) private readonly credentials: NodeCredentialStore,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    private readonly events: DomainEventBus,
  ) {}

  async execute(identity: NodeIdentity, csrPem: string): Promise<IssuedCertificate> {
    await this.authenticate.execute(identity);
    if (Buffer.byteLength(csrPem, 'utf8') > 8192) {
      throw new InvalidInputError('csr_too_large', 'certificate request exceeds the size limit');
    }
    // The authenticated identity, not the CSR's subject or SAN, determines the new certificate.
    const issued = await this.ca.issueNodeCertificate(csrPem, identity);
    await this.transaction.run(async () => {
      const now = new Date();
      if (
        !(await this.credentials.replace(
          identity,
          {
            id: uuidv7(),
            nodeId: identity.nodeId,
            serial: issued.serial,
            notBefore: issued.notBefore,
            notAfter: issued.notAfter,
            revokedAt: null,
          },
          now,
        ))
      )
        throw new NodeAuthenticationError();
      await this.events.publish([
        createEvent({
          type: 'fleet.node.certificate_renewed',
          organizationId: identity.organizationId,
          actor: { kind: 'node', id: identity.nodeId },
          target: { type: 'node', id: identity.nodeId },
          payload: {
            previousSerial: identity.serial,
            certificateSerial: issued.serial,
            certificateNotAfter: issued.notAfter.toISOString(),
          },
        }),
      ]);
    });
    return issued;
  }
}

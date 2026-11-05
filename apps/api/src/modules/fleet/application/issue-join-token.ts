import { Inject, Injectable } from '@nestjs/common';
import { type Actor, Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { joinTokenIssued } from '../domain/events';
import {
  generateJoinTokenValue,
  hashJoinToken,
  type IssuedJoinToken,
  JOIN_TOKEN_TTL_MS,
} from '../domain/join-token';

import {
  CERTIFICATE_AUTHORITY,
  type CertificateAuthority,
  FLEET_TRANSACTION,
  type FleetTransaction,
  JOIN_TOKEN_STORE,
  type JoinTokenStore,
} from './ports';

export interface IssueJoinTokenCommand {
  organizationId: string;
  actor: Actor;
}

export interface IssueJoinTokenResult extends IssuedJoinToken {
  /** Fingerprint the operator passes to the installer so the agent can pin the CA. */
  caFingerprint: string;
}

/** Issues a single-use join token valid for 15 minutes (SPEC section 3.2). */
@Injectable()
export class IssueJoinToken {
  constructor(
    @Inject(JOIN_TOKEN_STORE) private readonly tokens: JoinTokenStore,
    @Inject(CERTIFICATE_AUTHORITY) private readonly ca: CertificateAuthority,
    private readonly events: DomainEventBus,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
  ) {}

  async execute(command: IssueJoinTokenCommand, now = new Date()): Promise<IssueJoinTokenResult> {
    const id = uuidv7();
    const value = new Secret(generateJoinTokenValue());
    const expiresAt = new Date(now.getTime() + JOIN_TOKEN_TTL_MS);
    // The token row and its audit event commit together (rule 6): a failed audit leaves no token.
    await this.transaction.runTenant(command.organizationId, async () => {
      await this.tokens.insert({
        id,
        organizationId: command.organizationId,
        tokenHash: hashJoinToken(value.expose()),
        createdBy: command.actor.id ?? null,
        createdAt: now,
        expiresAt,
        usedAt: null,
        usedByNodeId: null,
      });
      await this.events.publish([
        joinTokenIssued({
          organizationId: command.organizationId,
          tokenId: id,
          expiresAt,
          actor: command.actor,
        }),
      ]);
    });
    return { id, value, expiresAt, caFingerprint: await this.ca.caFingerprint() };
  }
}

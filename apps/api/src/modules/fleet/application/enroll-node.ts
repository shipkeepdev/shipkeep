import { Inject, Injectable } from '@nestjs/common';
import { ConflictError } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { nodeEnrolled } from '../domain/events';
import {
  evaluateJoinToken,
  hashJoinToken,
  isWellFormedJoinToken,
  JoinTokenRejectedError,
} from '../domain/join-token';
import {
  assertNodeName,
  type NodeFacts,
  nodeNameFromHostname,
  sanitizeFacts,
} from '../domain/node';

import {
  CERTIFICATE_AUTHORITY,
  type CertificateAuthority,
  CONFIRMATION_KEY_PROVIDER,
  type ConfirmationKeyProvider,
  FLEET_TRANSACTION,
  type FleetTransaction,
  JOIN_TOKEN_STORE,
  type JoinTokenStore,
  NODE_STORE,
  type NodeStore,
} from './ports';

export interface EnrollNodeCommand {
  joinToken: string;
  csrPem: string;
  facts: Readonly<Record<string, unknown>>;
  agentVersion: string;
  /** Explicit node name; defaults to the hostname fact. */
  name?: string;
  ip?: string;
}

export interface EnrollNodeResult {
  nodeId: string;
  organizationId: string;
  certificatePem: string;
  certificateNotAfter: Date;
  caPem: string;
  leaseEpoch: number;
  confirmationPublicKeyPem: string;
}

/** First lease epoch of a node (ADR 0008). */
const INITIAL_LEASE_EPOCH = 1;
const MAX_CSR_BYTES = 8 * 1024;

/**
 * Enrolls a node: validates the join token, signs its CSR, records the node and its certificate,
 * consumes the token and emits the audit event (SPEC section 3.2, ARCHITECTURE flow 1).
 */
@Injectable()
export class EnrollNode {
  constructor(
    @Inject(JOIN_TOKEN_STORE) private readonly tokens: JoinTokenStore,
    @Inject(NODE_STORE) private readonly nodes: NodeStore,
    @Inject(CERTIFICATE_AUTHORITY) private readonly ca: CertificateAuthority,
    @Inject(CONFIRMATION_KEY_PROVIDER) private readonly confirmation: ConfirmationKeyProvider,
    private readonly events: DomainEventBus,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
  ) {}

  execute(command: EnrollNodeCommand, now = new Date()): Promise<EnrollNodeResult> {
    return this.transaction.run(() => this.enroll(command, now));
  }

  private async enroll(command: EnrollNodeCommand, now: Date): Promise<EnrollNodeResult> {
    if (!isWellFormedJoinToken(command.joinToken)) throw new JoinTokenRejectedError('malformed');
    if (Buffer.byteLength(command.csrPem, 'utf8') > MAX_CSR_BYTES) {
      throw new ConflictError('csr_too_large', 'certificate request exceeds the size limit');
    }
    const record = await this.tokens.findByHash(hashJoinToken(command.joinToken));
    const verdict = evaluateJoinToken(command.joinToken, record, now);
    if (!verdict.ok) throw new JoinTokenRejectedError(verdict.reason);
    const organizationId = verdict.record.organizationId;

    const facts = sanitizeFacts(command.facts);
    const name = this.resolveName(command.name, facts);
    if (await this.nodes.findByName(organizationId, name)) {
      throw new ConflictError('node_name_taken', `a node named ${name} already exists`, { name });
    }

    const nodeId = uuidv7();
    // The CA verifies the CSR signature and ignores every name it carries.
    const issued = await this.ca.issueNodeCertificate(command.csrPem, { organizationId, nodeId });

    await this.nodes.insert({
      id: nodeId,
      organizationId,
      name,
      status: 'enrolling',
      labels: {},
      facts: { ...facts, agent_version: command.agentVersion.slice(0, 64) },
      leaseEpoch: INITIAL_LEASE_EPOCH,
      createdAt: now,
      lastHeartbeatAt: null,
    });
    await this.nodes.insertCertificate({
      id: uuidv7(),
      nodeId,
      serial: issued.serial,
      notBefore: issued.notBefore,
      notAfter: issued.notAfter,
      revokedAt: null,
    });
    // Consuming last and atomically means a token can never enroll two nodes.
    if (!(await this.tokens.consume(verdict.record.id, nodeId, now))) {
      throw new JoinTokenRejectedError('used');
    }

    await this.events.publish([
      nodeEnrolled({
        organizationId,
        nodeId,
        name,
        tokenId: verdict.record.id,
        certificateSerial: issued.serial,
        certificateNotAfter: issued.notAfter,
        ...(command.ip ? { ip: command.ip } : {}),
      }),
    ]);

    return {
      nodeId,
      organizationId,
      certificatePem: issued.certificatePem,
      certificateNotAfter: issued.notAfter,
      caPem: await this.ca.caCertificatePem(),
      leaseEpoch: INITIAL_LEASE_EPOCH,
      confirmationPublicKeyPem: await this.confirmation.publicKeyPem(),
    };
  }

  private resolveName(explicit: string | undefined, facts: NodeFacts): string {
    if (explicit !== undefined) {
      assertNodeName(explicit);
      return explicit;
    }
    const hostname = facts['hostname'];
    const derived = typeof hostname === 'string' ? nodeNameFromHostname(hostname) : undefined;
    return derived ?? `node-${uuidv7().slice(-8)}`;
  }
}

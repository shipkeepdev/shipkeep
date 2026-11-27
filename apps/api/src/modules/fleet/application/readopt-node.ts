import { Inject, Injectable } from '@nestjs/common';
import type { Actor } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { nodeReadopted, nodeReadoptionRequested } from '../domain/events';
import type { NodeIdentity } from '../domain/node-identity';
import {
  type PresentedValidity,
  presentationOutcome,
  readoptable,
  worthRecording,
} from '../domain/node-readoption';

import {
  FLEET_TRANSACTION,
  type FleetTransaction,
  NODE_CREDENTIAL_STORE,
  NODE_READOPTION_STORE,
  NODE_STORE,
  type NodeCredentialStore,
  type NodeReadoptionStore,
  type NodeStore,
} from './ports';

/**
 * Re-adoption of a node whose registered certificate a restore rolled back (#487, SPEC 3.1). The
 * gateway reports each certificate it refused after TLS verified it; only an administrator's
 * confirmation registers one.
 */
@Injectable()
export class NodeReadoptions {
  constructor(
    @Inject(NODE_CREDENTIAL_STORE) private readonly credentials: NodeCredentialStore,
    @Inject(NODE_STORE) private readonly nodes: NodeStore,
    @Inject(NODE_READOPTION_STORE) private readonly readoptions: NodeReadoptionStore,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Records a refused certificate when it is worth an administrator's look: unknown to the registry,
   * current, for a node of its organization that was not removed. The identity comes from a
   * certificate the installation CA signed, as TLS verified it.
   */
  async notice(
    identity: NodeIdentity,
    presented: PresentedValidity,
    now = new Date(),
  ): Promise<void> {
    const known =
      (await this.credentials.find(identity.organizationId, identity.serial)) !== undefined;
    if (known) return;
    await this.transaction.runTenant(identity.organizationId, async () => {
      const node = await this.nodes.findById(identity.organizationId, identity.nodeId);
      if (!worthRecording(known, presented, node, now)) return;
      const recorded = await this.readoptions.find(identity.organizationId, identity.nodeId);
      const outcome = presentationOutcome(recorded, identity.serial, now);
      if (outcome === 'none') return;
      await this.readoptions.save({
        ...identity,
        ...presented,
        firstSeenAt: outcome === 'refresh' && recorded ? recorded.firstSeenAt : now,
        lastSeenAt: now,
      });
      if (outcome === 'record')
        await this.events.publish([
          nodeReadoptionRequested({ ...identity, notAfter: presented.notAfter }),
        ]);
    });
  }

  /**
   * Registers the node's waiting certificate and revokes its others; the caller authorized it.
   * `serial` is the certificate the administrator reviewed (#545): another one waiting answers
   * `ReadoptionChangedError`, and adopts nothing.
   */
  async confirm(
    input: {
      readonly organizationId: string;
      readonly nodeId: string;
      readonly serial: string;
      readonly actor: Actor;
    },
    now = new Date(),
  ): Promise<{ serial: string; notAfter: Date }> {
    return this.transaction.runTenant(input.organizationId, async () => {
      const node = await this.nodes.findById(input.organizationId, input.nodeId);
      const request = readoptable(
        await this.readoptions.find(input.organizationId, input.nodeId),
        node,
        now,
        input.serial,
      );
      const revokedSerials = await this.readoptions.adopt(request, uuidv7(), now);
      await this.events.publish([
        nodeReadopted({
          organizationId: input.organizationId,
          nodeId: input.nodeId,
          serial: request.serial,
          notAfter: request.notAfter,
          revokedSerials,
          actor: input.actor,
        }),
      ]);
      return { serial: request.serial, notAfter: request.notAfter };
    });
  }

  /** The organization's waiting certificates, by node. */
  pending(organizationId: string): ReturnType<NodeReadoptionStore['list']> {
    return this.transaction.runTenant(organizationId, () => this.readoptions.list(organizationId));
  }
}

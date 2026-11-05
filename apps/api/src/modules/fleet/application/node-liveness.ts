import { Inject, Injectable } from '@nestjs/common';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { nodeReady } from '../domain/events';
import { statusAfterHeartbeat } from '../domain/node';
import type { NodeIdentity } from '../domain/node-identity';

import { FLEET_TRANSACTION, type FleetTransaction, NODE_STORE, type NodeStore } from './ports';

/**
 * Minimal node liveness until leases land (M4.5): a connected agent's heartbeats keep its node
 * ready. Missed heartbeats are read as suspect or down by `observedStatus`.
 */
@Injectable()
export class NodeLiveness {
  constructor(
    @Inject(NODE_STORE) private readonly nodes: NodeStore,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    private readonly events: DomainEventBus,
  ) {}

  /** Records a heartbeat; a status change is audited in the same transaction. */
  heartbeat(identity: NodeIdentity, now = new Date()): Promise<void> {
    return this.transaction.runTenant(identity.organizationId, async () => {
      const node = await this.nodes.findById(identity.organizationId, identity.nodeId);
      if (!node || node.status === 'removed') return;
      const next = statusAfterHeartbeat(node.status);
      const recorded = await this.nodes.heartbeat(
        identity.organizationId,
        identity.nodeId,
        node.status,
        next,
        now,
      );
      if (recorded && next !== node.status)
        await this.events.publish([
          nodeReady({
            organizationId: identity.organizationId,
            nodeId: identity.nodeId,
            from: node.status,
          }),
        ]);
    });
  }
}

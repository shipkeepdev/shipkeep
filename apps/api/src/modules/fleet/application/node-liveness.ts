import { Inject, Injectable } from '@nestjs/common';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { agentVersionChanged, nodeReady } from '../domain/events';
import { AGENT_VERSION, type NodeRecord, statusAfterHeartbeat } from '../domain/node';
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
      if (node && node.status !== 'removed') await this.beat(identity, node, now);
    });
  }

  /**
   * Records a hello: a heartbeat, and the agent's version when it differs from the stored one,
   * which is how the control plane learns that an upgrade or its rollback happened (ADR 0028).
   * Both changes are audited in the same transaction.
   */
  hello(identity: NodeIdentity, agentVersion: string, now = new Date()): Promise<void> {
    return this.transaction.runTenant(identity.organizationId, async () => {
      const node = await this.nodes.findById(identity.organizationId, identity.nodeId);
      if (!node || node.status === 'removed') return;
      await this.beat(identity, node, now);
      const previous = node.facts['agent_version'];
      if (!AGENT_VERSION.test(agentVersion) || previous === agentVersion) return;
      await this.nodes.updateFacts(identity.organizationId, identity.nodeId, {
        ...node.facts,
        agent_version: agentVersion,
      });
      await this.events.publish([
        agentVersionChanged({
          organizationId: identity.organizationId,
          nodeId: identity.nodeId,
          from: typeof previous === 'string' ? previous : null,
          to: agentVersion,
        }),
      ]);
    });
  }

  private async beat(identity: NodeIdentity, node: NodeRecord, now: Date): Promise<void> {
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
  }
}

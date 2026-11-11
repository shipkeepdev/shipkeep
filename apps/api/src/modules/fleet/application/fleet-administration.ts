import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, type Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { isPublicAddress } from '../../../platform/net/public-address';
import { ConfirmationVerifier } from '../../confirmations/application/confirmation-verifier';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { MfaProofInput } from '../../identity/application/mfa-crypto';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import { nodePublicAddressesChanged, nodeRemoved } from '../domain/events';
import type { NodeRecord } from '../domain/node';
import { nodePublicAddresses, samePublicAddresses } from '../domain/node-address';

import { IssueJoinToken, type IssueJoinTokenResult } from './issue-join-token';
import { FLEET_TRANSACTION, type FleetTransaction, NODE_STORE, type NodeStore } from './ports';

/**
 * Organization administration of the fleet over HTTP (PLAN M2.7a). Every operation requires live
 * `node.manage` on the organization; issuing an enrollment credential also requires the caller's
 * password and configured second factor.
 */
@Injectable()
export class FleetAdministration {
  constructor(
    private readonly issue: IssueJoinToken,
    @Inject(NODE_STORE) private readonly nodes: NodeStore,
    @Inject(FLEET_TRANSACTION) private readonly transaction: FleetTransaction,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly confirmations: ConfirmationVerifier,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Removes a node (SPEC 7, destructive): needs `node.manage` and a confirmation token for this
   * exact node, spent in the same transaction. The node's certificates are revoked, so its
   * gateway stream closes at the next credential check.
   */
  removeNode(
    context: SecurityContext,
    organizationId: string,
    nodeId: string,
    confirmation: Secret,
    now = new Date(),
  ): Promise<void> {
    const target = { organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'node.manage', target);
        await this.transaction.runTenant(organizationId, async () => {
          const node = await this.nodes.findById(organizationId, nodeId);
          if (!node || node.status === 'removed') throw new NotFoundError('resource');
          const confirmationId = await this.confirmations.consume(
            confirmation,
            { organizationId, action: 'node.remove', target: nodeId },
            context.userId,
            now,
          );
          if (!(await this.nodes.remove(organizationId, nodeId, now)))
            throw new NotFoundError('resource');
          await this.events.publish([
            nodeRemoved({
              organizationId,
              nodeId,
              name: node.name,
              confirmationId,
              actor: resourceActor(context),
            }),
          ]);
        });
      },
      { permission: 'node.manage', target },
    );
  }

  /**
   * Replaces the public addresses an administrator declares for a node (PLAN M3.6b1): needs
   * `node.manage`. Values are validated before any lookup; saving the same list records nothing.
   */
  setPublicAddresses(
    context: SecurityContext,
    organizationId: string,
    nodeId: string,
    input: readonly unknown[],
  ): Promise<NodeRecord> {
    const addresses = nodePublicAddresses(input, isPublicAddress);
    const target = { organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'node.manage', target);
        return this.transaction.runTenant(organizationId, async () => {
          const node = await this.nodes.findById(organizationId, nodeId);
          if (!node || node.status === 'removed') throw new NotFoundError('resource');
          if (samePublicAddresses(node.publicAddresses, addresses)) return node;
          const updated = await this.nodes.setPublicAddresses(organizationId, nodeId, addresses);
          if (!updated) throw new NotFoundError('resource');
          await this.events.publish([
            nodePublicAddressesChanged({
              organizationId,
              nodeId,
              name: node.name,
              addresses,
              previous: node.publicAddresses,
              actor: resourceActor(context),
            }),
          ]);
          return updated;
        });
      },
      { permission: 'node.manage', target },
    );
  }

  issueJoinToken(
    context: SecurityContext,
    organizationId: string,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<IssueJoinTokenResult> {
    return this.accounts.reauthenticated(
      context,
      password,
      factor,
      async () => {
        await this.access.require(context.userId, 'node.manage', { organizationId });
        return this.issue.execute(
          { organizationId, actor: { kind: 'user', id: context.userId, ip: context.ip } },
          now,
        );
      },
      now,
    );
  }

  listNodes(
    context: SecurityContext,
    organizationId: string,
    beforeId?: string,
  ): Promise<NodeRecord[]> {
    return this.accounts.run(context, async () => {
      await this.access.require(context.userId, 'node.manage', { organizationId });
      return this.transaction.runTenant(organizationId, () =>
        this.nodes.list(organizationId, beforeId),
      );
    });
  }
}

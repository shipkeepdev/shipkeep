import { Inject, Injectable } from '@nestjs/common';
import type { Secret } from '@shipkeep/domain';

import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { MfaProofInput } from '../../identity/application/mfa-crypto';
import type { ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import type { NodeRecord } from '../domain/node';

import { IssueJoinToken, type IssueJoinTokenResult } from './issue-join-token';
import { FLEET_TRANSACTION, type FleetTransaction, NODE_STORE, type NodeStore } from './ports';

/**
 * Organization administration of the fleet over HTTP (PLAN M2.7a). Both operations require live
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
  ) {}

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

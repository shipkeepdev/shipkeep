import { create } from '@bufbuild/protobuf';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConflictError, createEvent, NotFoundError, type Secret } from '@shipkeep/domain';
import { RemoveContainerSchema } from '@shipkeep/proto-ts';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { ConfirmationTargets } from '../../confirmations/application/confirmation-targets';
import { ConfirmationVerifier } from '../../confirmations/application/confirmation-verifier';
import type {
  ConfirmationTarget,
  ConfirmationTargetResolver,
} from '../../confirmations/application/ports';
import type { ConfirmationRequest } from '../../confirmations/domain/confirmation-token';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import {
  resourceActor,
  type ResourceSecurityContext as SecurityContext,
} from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import {
  ownerSuffixes,
  parseUntrackedTarget,
  type UntrackedContainer,
  untrackedContainers,
  untrackedTarget,
} from '../domain/untracked-containers';

import {
  ACTION_QUEUE,
  type ActionQueue,
  DEPLOYMENT_TRANSACTION,
  type DeploymentTransaction,
  OBSERVATION_STORE,
  type ObservationStore,
} from './ports';

/** How long a server has to remove an untracked container: the same hour as a cleanup. */
const REMOVAL_DEADLINE_MS = 60 * 60_000;

export class ContainerNotUntrackedError extends ConflictError {
  constructor() {
    super(
      'container_not_untracked',
      'this container is not untracked on this server any more: read the list again',
    );
  }
}

/**
 * Untracked containers of a server (#501, SPEC 3.5): what its agent reports and no placed replica
 * matches, named after an application of the organization that is not being deployed. They are
 * listed on the server's page, and removed one at a time on a confirmation by name (SPEC 3.6),
 * without their volumes. Both need `node.manage`.
 */
@Injectable()
export class UntrackedContainers implements ConfirmationTargetResolver, OnModuleInit {
  constructor(
    @Inject(OBSERVATION_STORE) private readonly store: ObservationStore,
    @Inject(DEPLOYMENT_TRANSACTION) private readonly transaction: DeploymentTransaction,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly confirmations: ConfirmationVerifier,
    private readonly targets: ConfirmationTargets,
    private readonly events: DomainEventBus,
  ) {}

  onModuleInit(): void {
    this.targets.register('node.container.remove', this);
  }

  /** Called inside the requester's tenant transaction: the name to type is the container's. */
  async resolve(request: ConfirmationRequest): Promise<ConfirmationTarget | null> {
    const target = parseUntrackedTarget(request.target);
    if (!target) return null;
    const found = (await this.untracked(request.organizationId, target.nodeId)).find(
      (container) => container.name === target.name,
    );
    return found ? { name: found.name } : null;
  }

  list(
    context: SecurityContext,
    organizationId: string,
    nodeId: string,
  ): Promise<UntrackedContainer[]> {
    return this.accounts.run(context, async () => {
      await this.access.require(context.userId, 'node.manage', { organizationId });
      return this.transaction.runTenant(organizationId, async () => {
        if (!(await this.store.onNode(organizationId, nodeId, 1)))
          throw new NotFoundError('resource');
        return this.untracked(organizationId, nodeId);
      });
    });
  }

  /**
   * Asks the server to remove one untracked container, on a confirmation by its name spent in
   * the same transaction. Its volumes stay. Audited as `node.untracked_container_removal_requested`;
   * the agent's result is the action's own audit.
   */
  remove(
    context: SecurityContext,
    organizationId: string,
    nodeId: string,
    name: string,
    confirmation: Secret,
    now = new Date(),
  ): Promise<{ actionId: string }> {
    const target = { organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, 'node.manage', target);
        return this.transaction.runTenant(organizationId, async () => {
          if (!(await this.store.onNode(organizationId, nodeId, 1)))
            throw new NotFoundError('resource');
          const container = (await this.untracked(organizationId, nodeId)).find(
            (candidate) => candidate.name === name,
          );
          if (!container) throw new ContainerNotUntrackedError();
          const confirmationId = await this.confirmations.consume(
            confirmation,
            {
              organizationId,
              action: 'node.container.remove',
              target: untrackedTarget(nodeId, name),
            },
            context.userId,
            now,
          );
          const queued = await this.queue.enqueue({
            organizationId,
            nodeId,
            idempotencyKey: `u:${confirmationId}:remove`,
            action: {
              case: 'removeContainer',
              value: create(RemoveContainerSchema, { containerId: container.name }),
            },
            deadline: new Date(now.getTime() + REMOVAL_DEADLINE_MS),
            actor: resourceActor(context),
          });
          await this.events.publish([
            createEvent({
              type: 'node.untracked_container_removal_requested',
              organizationId,
              actor: resourceActor(context),
              target: { type: 'node', id: nodeId },
              payload: {
                container: container.name,
                containerId: container.containerId,
                applicationId: container.application.id,
                release: container.release,
                confirmationId,
                actionId: queued.id,
              },
              occurredAt: now,
            }),
          ]);
          return { actionId: queued.id };
        });
      },
      { permission: 'node.manage', target },
    );
  }

  /** Run under `runTenant(organizationId)`. */
  private async untracked(organizationId: string, nodeId: string): Promise<UntrackedContainer[]> {
    const unmatched = await this.store.unmatchedOnNode(organizationId, nodeId);
    if (!unmatched.length) return [];
    const applications = await this.store.owningApplications(
      organizationId,
      ownerSuffixes(unmatched),
    );
    return untrackedContainers(unmatched, applications);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { createEvent, InvalidInputError, NotFoundError, Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import {
  CONFIRMATION_KEY_PROVIDER,
  type ConfirmationKeyProvider,
} from '../../fleet/application/ports';
import { AccountMutationAuthority } from '../../identity/application/account-mutation-authority';
import type { ResourceSecurityContext as SecurityContext } from '../../identity/application/resource-security-context';
import { TenantAccess } from '../../organizations/application/tenant-access';
import {
  CONFIRMABLE_ACTIONS,
  compactToken,
  confirmationClaims,
  confirmationNameMatches,
  type ConfirmationRequest,
  isConfirmableAction,
  signingInput,
} from '../domain/confirmation-token';

import { ConfirmationTargets } from './confirmation-targets';
import {
  CONFIRMATION_STORE,
  CONFIRMATION_TRANSACTION,
  type ConfirmationStore,
  type ConfirmationTransaction,
} from './ports';

/**
 * Issues confirmation tokens (SPEC 3.6) after the requester typed the resource's exact current
 * name. The requester must hold the action's permission now; the destructive command checks it
 * again when it consumes the token.
 */
@Injectable()
export class ConfirmationCommands {
  constructor(
    @Inject(CONFIRMATION_STORE) private readonly store: ConfirmationStore,
    @Inject(CONFIRMATION_TRANSACTION) private readonly transaction: ConfirmationTransaction,
    @Inject(CONFIRMATION_KEY_PROVIDER) private readonly keys: ConfirmationKeyProvider,
    private readonly targets: ConfirmationTargets,
    private readonly accounts: AccountMutationAuthority,
    private readonly access: TenantAccess,
    private readonly events: DomainEventBus,
  ) {}

  async issue(
    context: SecurityContext,
    input: { organizationId: string; action: string; target: string; typedName: string },
    now = new Date(),
  ): Promise<{ id: string; token: Secret; expiresAt: Date }> {
    if (!isConfirmableAction(input.action))
      throw new InvalidInputError(
        'unknown_confirmation_action',
        'This action needs no confirmation.',
      );
    const request: ConfirmationRequest = {
      organizationId: input.organizationId,
      action: input.action,
      target: input.target,
    };
    const permission = CONFIRMABLE_ACTIONS[request.action].permission;
    const scope = { organizationId: request.organizationId };
    return this.accounts.run(
      context,
      async () => {
        await this.access.require(context.userId, permission, scope);
        const resource = await this.transaction.runTenant(request.organizationId, () =>
          this.targets.resolve(request),
        );
        if (!resource) throw new NotFoundError('resource');
        if (!confirmationNameMatches(input.typedName, resource.name))
          throw new InvalidInputError(
            'confirmation_name_mismatch',
            'Type the exact current name of the resource to confirm.',
          );
        const id = uuidv7();
        const claims = confirmationClaims({ id, request, userId: context.userId, now });
        const expiresAt = new Date(claims.exp * 1000);
        await this.transaction.runTenant(request.organizationId, () =>
          this.store.insert({
            id,
            ...request,
            userId: context.userId,
            issuedAt: new Date(claims.iat * 1000),
            expiresAt,
            usedAt: null,
          }),
        );
        await this.events.publish([
          createEvent({
            type: 'confirmation.issued',
            organizationId: request.organizationId,
            actor: { kind: 'user', id: context.userId, ip: context.ip },
            target: { type: 'confirmation', id },
            payload: { action: request.action, target: request.target },
            occurredAt: now,
          }),
        ]);
        const message = signingInput(claims);
        const signature = await this.keys.signConfirmation(Buffer.from(message, 'utf8'));
        return { id, token: new Secret(compactToken(message, signature)), expiresAt };
      },
      { permission, target: scope },
    );
  }
}

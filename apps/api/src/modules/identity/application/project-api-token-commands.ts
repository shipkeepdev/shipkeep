import { Inject, Injectable } from '@nestjs/common';
import {
  type ApiTokenProject,
  createEvent,
  isTenantId,
  NotFoundError,
  type Secret,
} from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';

import { AccountMutationAuthority } from './account-mutation-authority';
import { API_TOKEN_AUTHORITY, type ApiTokenAuthority } from './api-token-authority';
import { type ApiTokenMetadata, metadata } from './api-token-commands';
import { API_TOKEN_STORE, type ApiTokenStore } from './api-token-store';
import type { MfaProofInput } from './mfa-crypto';
import type { ResourceSecurityContext as SecurityContext } from './resource-security-context';

export type ProjectApiTokenMetadata = ApiTokenMetadata & { readonly createdBy: string };

/**
 * Administration of project-bound tokens by the project's administrators (PLAN M2.3e2), whoever
 * created them. Both operations require live `member.manage` on the project.
 */
@Injectable()
export class ProjectApiTokenCommands {
  constructor(
    @Inject(API_TOKEN_STORE) private readonly tokens: ApiTokenStore,
    @Inject(API_TOKEN_AUTHORITY) private readonly authority: ApiTokenAuthority,
    private readonly accounts: AccountMutationAuthority,
    private readonly events: DomainEventBus,
  ) {}

  async list(
    context: SecurityContext,
    project: ApiTokenProject,
    beforeId?: string,
    now = new Date(),
  ): Promise<ProjectApiTokenMetadata[]> {
    return this.accounts.run(context, async () => {
      await this.requireManage(context.userId, project);
      return (await this.tokens.listProject(target(project), beforeId)).map((record) => ({
        ...metadata(record, record.creatorSecurityVersion, now),
        createdBy: record.userId,
      }));
    });
  }

  async revoke(
    context: SecurityContext,
    project: ApiTokenProject,
    id: string,
    password: Secret,
    factor: MfaProofInput,
    now = new Date(),
  ): Promise<void> {
    if (!isTenantId(id)) throw new NotFoundError('api_token');
    await this.requireManage(context.userId, project);
    const initial = await this.tokens.findInProject(target(project), id);
    if (!initial) throw new NotFoundError('api_token');
    // Revocation serializes with the creator's bearer authentication through the creator's lock.
    await this.accounts.reauthenticatedWith(
      context,
      initial.userId,
      password,
      factor,
      async () => {
        await this.requireManage(context.userId, project);
        const current = await this.tokens.findInProject(target(project), id);
        if (!current || current.userId !== initial.userId) throw new NotFoundError('api_token');
        if (current.revokedAt) return;
        if (!(await this.tokens.revokeInProject(target(project), id, now))) return;
        await this.events.publish([
          createEvent({
            type: 'identity.api_token_revoked',
            organizationId: project.organizationId,
            actor: { kind: 'user', id: context.userId, ip: context.ip },
            target: { type: 'api_token', id },
            payload: { projectId: project.projectId, createdBy: current.userId },
            occurredAt: now,
          }),
        ]);
      },
      now,
    );
  }

  private async requireManage(userId: string, project: ApiTokenProject): Promise<void> {
    if (!(await this.authority.allows(userId, 'member.manage', target(project))))
      throw new NotFoundError('resource');
  }
}

/** Only the two canonical ids, never extra fields from a caller-built object. */
function target(project: ApiTokenProject): ApiTokenProject {
  return { organizationId: project.organizationId, projectId: project.projectId };
}

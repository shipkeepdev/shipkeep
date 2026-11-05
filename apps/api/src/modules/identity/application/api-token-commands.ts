import { Inject, Injectable } from '@nestjs/common';
import {
  API_TOKEN_MAX_ACTIVE,
  assertApiTokenExpiry,
  assertApiTokenName,
  ConflictError,
  createEvent,
  NotFoundError,
  type ApiTokenProject,
  InvalidInputError,
  parseApiScopes,
  scopesWithinProject,
  type Secret,
} from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { AuthenticationError } from '../domain/identity-policy';
import type { UserRecord } from '../domain/identity-records';
import { TokenPermissionError } from '../domain/token-permission-error';

import { API_TOKEN_AUTHORITY, type ApiTokenAuthority } from './api-token-authority';
import { API_TOKEN_STORE, type ApiTokenRecord, type ApiTokenStore } from './api-token-store';
import {
  IDENTITY_SECRETS,
  type IdentitySecrets,
  PASSWORD_HASHER,
  type PasswordHashing,
} from './identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './identity-store';
import type { SecurityContext } from './mfa-commands';
import type { MfaProofInput } from './mfa-crypto';
import { MfaProof } from './mfa-proof';

export type ApiTokenMetadata = Pick<
  ApiTokenRecord,
  'id' | 'name' | 'scopes' | 'project' | 'createdAt' | 'expiresAt' | 'revokedAt' | 'lastUsedAt'
> & {
  readonly status: 'active' | 'revoked' | 'expired' | 'invalidated';
};

@Injectable()
export class ApiTokenCommands {
  constructor(
    @Inject(IDENTITY_STORE) private readonly users: IdentityStore,
    @Inject(API_TOKEN_STORE) private readonly tokens: ApiTokenStore,
    @Inject(API_TOKEN_AUTHORITY) private readonly authority: ApiTokenAuthority,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHashing,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    private readonly mfa: MfaProof,
    private readonly events: DomainEventBus,
  ) {}

  async create(
    context: SecurityContext,
    input: { name: string; scopes: unknown; expiresAt: Date; project?: ApiTokenProject },
    password: Secret,
    proof: MfaProofInput,
    now = new Date(),
  ): Promise<{ metadata: ApiTokenMetadata; token: Secret }> {
    const name = assertApiTokenName(input.name);
    const scopes = parseApiScopes(input.scopes);
    const project = input.project
      ? { organizationId: input.project.organizationId, projectId: input.project.projectId }
      : null;
    if (project && !scopesWithinProject(scopes, project))
      throw new InvalidInputError(
        'invalid_api_token_scopes',
        'Every scope of a project token must stay inside that project.',
      );
    const expiresAt = new Date(input.expiresAt);
    assertApiTokenExpiry(expiresAt, now);
    await this.reauthenticate(context, password);
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      for (const scope of scopes)
        if (!(await this.authority.allows(user.id, scope.permission, scope)))
          throw new TokenPermissionError();
      // Binding credentials to a project is project administration (SPEC 7, member management).
      if (project && !(await this.authority.allows(user.id, 'member.manage', project)))
        throw new TokenPermissionError();
      if (
        (await this.tokens.countActive(user.id, user.securityVersion, now)) >= API_TOKEN_MAX_ACTIVE
      )
        throw new ConflictError(
          'api_token_limit',
          'Revoke an active API token before creating another.',
        );
      await this.mfa.verify(user.id, proof, now);
      const token = this.secrets.issue();
      const record: ApiTokenRecord = {
        id: uuidv7(),
        userId: user.id,
        name,
        scopes,
        project,
        tokenHash: this.secrets.hash('api', token),
        securityVersion: user.securityVersion,
        createdAt: now,
        expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      };
      await this.tokens.insert(record);
      await this.audit('created', record, context, now);
      return { metadata: metadata(record, user.securityVersion, now), token };
    });
  }

  async revoke(
    context: SecurityContext,
    id: string,
    password: Secret,
    proof: MfaProofInput,
    now = new Date(),
  ): Promise<void> {
    await this.reauthenticate(context, password);
    await this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      const record = await this.tokens.findOwned(user.id, id);
      if (!record) throw new NotFoundError('api_token');
      if (record.revokedAt) return;
      await this.mfa.verify(user.id, proof, now);
      if (await this.tokens.revoke(user.id, id, now))
        await this.audit('revoked', record, context, now);
    });
  }

  async list(
    context: SecurityContext,
    beforeId?: string,
    now = new Date(),
  ): Promise<ApiTokenMetadata[]> {
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      return (await this.tokens.list(user.id, beforeId)).map((record) =>
        metadata(record, user.securityVersion, now),
      );
    });
  }

  private async reauthenticate(context: SecurityContext, password: Secret): Promise<void> {
    const user = await this.users.findUser(context.userId);
    const matched = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !matched) throw new AuthenticationError();
    assertContext(user, context);
  }
  private async audit(
    action: 'created' | 'revoked',
    record: ApiTokenRecord,
    context: SecurityContext,
    now: Date,
  ): Promise<void> {
    const organizationId = record.scopes.find((scope) => scope.organizationId)?.organizationId;
    await this.events.publish([
      createEvent({
        type: `identity.api_token_${action}`,
        actor: { kind: 'user', id: context.userId, ip: context.ip },
        target: { type: 'api_token', id: record.id },
        ...(organizationId ? { organizationId } : {}),
        payload: record.project ? { projectId: record.project.projectId } : {},
        occurredAt: now,
      }),
    ]);
  }
}

function assertContext(user: UserRecord, context: SecurityContext): void {
  if (user.status !== 'active' || user.securityVersion !== context.securityVersion)
    throw new AuthenticationError();
}
function metadata(record: ApiTokenRecord, version: number, now: Date): ApiTokenMetadata {
  return {
    id: record.id,
    name: record.name,
    scopes: record.scopes,
    project: record.project,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    status: record.revokedAt
      ? 'revoked'
      : record.securityVersion !== version
        ? 'invalidated'
        : record.expiresAt <= now
          ? 'expired'
          : 'active',
  };
}

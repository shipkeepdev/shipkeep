import { Inject, Injectable } from '@nestjs/common';
import { type Permission, type ResourceContext, scopeCovers, type Secret } from '@shipkeep/domain';

import { AuthenticationError, TOKEN_PATTERN } from '../domain/identity-policy';
import type { UserRecord } from '../domain/identity-records';
import { TokenPermissionError } from '../domain/token-permission-error';

import { API_TOKEN_AUTHORITY, type ApiTokenAuthority } from './api-token-authority';
import { API_TOKEN_STORE, type ApiTokenRecord, type ApiTokenStore } from './api-token-store';
import { IDENTITY_SECRETS, type IdentitySecrets } from './identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './identity-store';

interface AuthenticatedToken {
  readonly user: UserRecord;
  readonly token: ApiTokenRecord;
}

@Injectable()
export class ApiTokenAuthentication {
  constructor(
    @Inject(IDENTITY_STORE) private readonly users: IdentityStore,
    @Inject(API_TOKEN_STORE) private readonly tokens: ApiTokenStore,
    @Inject(API_TOKEN_AUTHORITY) private readonly authority: ApiTokenAuthority,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
  ) {}

  /** No route gains bearer access without an explicit permission and validated resource context. */
  async authenticate(
    value: Secret,
    permission: Permission,
    target: ResourceContext,
    now = new Date(),
  ): Promise<AuthenticatedToken> {
    return this.withCredential(value, now, async (current) => {
      if (
        !current.token.scopes.some((scope) => scopeCovers(scope, permission, target)) ||
        !(await this.authority.allows(current.user.id, permission, target))
      )
        throw new TokenPermissionError();
      if (!(await this.tokens.touch(current.token.id, now))) throw new AuthenticationError();
      return current;
    });
  }

  /** Before revealing an encrypted creation retry, recheck ownership, liveness and all grants. */
  async assertReplayAvailable(
    userId: string,
    version: number,
    value: Secret,
    now = new Date(),
  ): Promise<void> {
    await this.withCredential(value, now, async ({ user, token }) => {
      if (user.id !== userId || user.securityVersion !== version) throw new AuthenticationError();
      for (const scope of token.scopes)
        if (!(await this.authority.allows(user.id, scope.permission, scope)))
          throw new TokenPermissionError();
    });
  }

  private async withCredential<T>(
    value: Secret,
    now: Date,
    operation: (current: AuthenticatedToken) => Promise<T>,
  ): Promise<T> {
    if (!TOKEN_PATTERN.test(value.expose())) throw new AuthenticationError();
    const hash = this.secrets.hash('api', value);
    const initial = await this.tokens.findByHash(hash);
    if (!initial) throw new AuthenticationError();
    return this.users.withUserLock(initial.userId, async (user) => {
      // Re-read under the same lock used by revocation, password resets and role changes.
      const token = await this.tokens.findOwned(user.id, initial.id);
      if (
        !token ||
        token.tokenHash !== hash ||
        user.status !== 'active' ||
        token.securityVersion !== user.securityVersion ||
        token.revokedAt !== null ||
        token.createdAt > now ||
        token.expiresAt <= now
      )
        throw new AuthenticationError();
      return operation({ user, token });
    });
  }
}

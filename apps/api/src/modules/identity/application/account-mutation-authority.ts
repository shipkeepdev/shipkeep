import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';
import { isTenantId, type Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { identityEvent } from '../domain/identity-events';
import { AuthenticationError, normalizeEmail } from '../domain/identity-policy';
import type { UserRecord } from '../domain/identity-records';

import { IDENTITY_STORE, type IdentityStore } from './identity-store';
import { PASSWORD_HASHER, type PasswordHashing } from './identity-ports';
import { ApiTokenAuthentication } from './api-token-authentication';
import type {
  CommandAuthority,
  ResourceSecurityContext as SecurityContext,
} from './resource-security-context';
import type { MfaProofInput } from './mfa-crypto';
import { MfaProof } from './mfa-proof';
import { SessionCommands, type SessionGrant } from './session-commands';

export interface AccountSubject {
  readonly userId: string;
  readonly email: string;
  readonly active: boolean;
}
export interface PrivilegeChangeResult<T> {
  readonly value: T;
  readonly session?: SessionGrant;
}

/** Public identity boundary for authenticated resource commands. The transport supplies context;
 * the callback must authorize the resource, perform its writes and publish its audit events.
 * Account mutation locks serialize against password resets and permission changes.
 */
@Injectable()
export class AccountMutationAuthority {
  private readonly proof = new AsyncLocalStorage<{
    userId: string;
    version: number;
    active: boolean;
  }>();

  constructor(
    @Inject(IDENTITY_STORE) private readonly users: IdentityStore,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHashing,
    private readonly mfa: MfaProof,
    private readonly sessions: SessionCommands,
    private readonly events: DomainEventBus,
    private readonly tokens: ApiTokenAuthentication,
  ) {}

  async run<T>(
    context: SecurityContext,
    operation: () => Promise<T>,
    authority?: CommandAuthority,
  ): Promise<T> {
    assertContextShape(context);
    return this.users.withUserLock(context.userId, async (user) => {
      assertAccount(user, context);
      if (context.apiCredential) {
        if (!authority) throw new AuthenticationError();
        await this.tokens.assertCommandAuthority(
          context.userId,
          context.apiCredential.id,
          context.apiCredential.value,
          authority.permission,
          authority.target,
        );
      }
      return operation();
    });
  }

  /**
   * `run` revalidates the account, and an API token when there is one. A browser session is only
   * checked when the request arrives; work that continues afterwards calls this before each step.
   */
  async assertSessionLive(context: SecurityContext, now = new Date()): Promise<void> {
    if (context.session) await this.sessions.assertLive(context.userId, context.session.token, now);
  }

  async reauthenticated<T>(
    context: SecurityContext,
    password: Secret,
    factor: MfaProofInput,
    operation: () => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    await this.verifyPassword(context, password);
    return this.run(context, async () => {
      await this.mfa.verify(context.userId, factor, now);
      return this.withProof(context, operation);
    });
  }

  /** Only the same reauthenticated callback can rotate its caller after gaining/changing roles. */
  async rotate(context: SecurityContext, now = new Date()): Promise<SessionGrant> {
    assertContextShape(context);
    const proof = this.proof.getStore();
    if (
      !proof?.active ||
      proof.userId !== context.userId ||
      proof.version !== context.securityVersion
    )
      throw new AuthenticationError();
    return this.sessions.rotateAuthenticated(context.userId, context.securityVersion, context, now);
  }

  /** Internal directory boundary. Callers must authorize member management first and recheck
   * this subject's email/active state under changePrivileges before adding membership.
   */
  async findVerifiedAccount(email: string): Promise<AccountSubject | null> {
    const normalized = normalizeEmail(email);
    return this.users.transaction(async () => {
      const user = await this.users.findUserByEmail(normalized);
      return user && subject(user).active ? subject(user) : null;
    });
  }

  /** Acquire both account locks in canonical order BEFORE any organization lock. Callers must
   * not enter with an actor lock already held. The callback authorizes and audits its role write.
   * A no-op does not invalidate credentials; changed privileges always do, including demotions.
   */
  async changePrivileges<T>(
    context: SecurityContext,
    affectedUserId: string,
    password: Secret,
    factor: MfaProofInput,
    operation: (account: AccountSubject) => Promise<{ value: T; changed: boolean }>,
    now = new Date(),
  ): Promise<PrivilegeChangeResult<T>> {
    if (!isTenantId(affectedUserId)) throw new AuthenticationError();
    await this.verifyPassword(context, password);
    const ids = [context.userId, affectedUserId].sort();
    const execute = async (
      first: UserRecord,
      second: UserRecord,
    ): Promise<PrivilegeChangeResult<T>> => {
      const actor = first.id === context.userId ? first : second;
      const affected = first.id === affectedUserId ? first : second;
      assertAccount(actor, context);
      await this.mfa.verify(context.userId, factor, now);
      return this.withProof(context, async () => {
        const result = await operation(subject(affected));
        if (!result.changed) {
          // A configured factor may have consumed a counter/recovery code even for a no-op.
          await this.events.publish([
            identityEvent(
              'privilege_change_confirmed',
              affected.id,
              { kind: 'user', id: context.userId, ip: context.ip },
              now,
            ),
          ]);
          return { value: result.value };
        }
        if (affected.id === context.userId)
          return { value: result.value, session: await this.rotate(context, now) };
        await this.users.advanceSecurityVersion(affected.id, now);
        await this.events.publish([
          identityEvent(
            'permissions_changed',
            affected.id,
            { kind: 'user', id: context.userId, ip: context.ip },
            now,
          ),
        ]);
        return { value: result.value };
      });
    };
    return this.users.withUserLock(ids[0], (first) =>
      ids[0] === ids[1]
        ? execute(first, first)
        : this.users.withUserLock(ids[1], (second) => execute(first, second)),
    );
  }

  /**
   * Reauthenticates the caller and holds both the caller's and `otherUserId`'s account locks, in
   * canonical order, around `operation`. Neither account's privileges or security version change;
   * use it to act on credentials another account owns, such as revoking a project token, so the
   * action serializes with that owner's bearer authentication.
   */
  async reauthenticatedWith<T>(
    context: SecurityContext,
    otherUserId: string,
    password: Secret,
    factor: MfaProofInput,
    operation: (other: AccountSubject) => Promise<T>,
    now = new Date(),
  ): Promise<T> {
    if (!isTenantId(otherUserId)) throw new AuthenticationError();
    await this.verifyPassword(context, password);
    const ids = [context.userId, otherUserId].sort();
    const execute = async (first: UserRecord, second: UserRecord): Promise<T> => {
      const actor = first.id === context.userId ? first : second;
      const other = first.id === otherUserId ? first : second;
      assertAccount(actor, context);
      await this.mfa.verify(context.userId, factor, now);
      return this.withProof(context, () => operation(subject(other)));
    };
    return this.users.withUserLock(ids[0], (first) =>
      ids[0] === ids[1]
        ? execute(first, first)
        : this.users.withUserLock(ids[1], (second) => execute(first, second)),
    );
  }

  /**
   * Checks the caller's current password without taking any lock. Callers use it before revealing
   * the outcome of a directory lookup, so an unknown address and a wrong password give the same
   * response and the lookup cannot be used as an account-existence oracle.
   */
  async confirmPassword(context: SecurityContext, password: Secret): Promise<void> {
    await this.verifyPassword(context, password);
  }

  private async verifyPassword(context: SecurityContext, password: Secret): Promise<void> {
    assertContextShape(context);
    if (context.apiCredential) throw new AuthenticationError();
    const user = await this.users.transaction(() => this.users.findUser(context.userId));
    const matched = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !matched) throw new AuthenticationError();
    assertAccount(user, context);
  }

  private withProof<T>(context: SecurityContext, operation: () => Promise<T>): Promise<T> {
    const proof = { userId: context.userId, version: context.securityVersion, active: true };
    return this.proof.run(proof, async () => {
      try {
        return await operation();
      } finally {
        proof.active = false;
      }
    });
  }
}

function subject(user: UserRecord): AccountSubject {
  return {
    userId: user.id,
    email: user.email,
    active: user.status === 'active' && user.emailVerifiedAt !== null,
  };
}

function assertContextShape(context: SecurityContext): void {
  if (
    !isTenantId(context.userId) ||
    !Number.isSafeInteger(context.securityVersion) ||
    context.securityVersion < 0
  )
    throw new AuthenticationError();
}
function assertAccount(user: UserRecord, context: SecurityContext): void {
  if (
    user.status !== 'active' ||
    user.emailVerifiedAt === null ||
    user.securityVersion !== context.securityVersion
  )
    throw new AuthenticationError();
}

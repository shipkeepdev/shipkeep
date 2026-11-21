import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, createEvent, NotFoundError } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { type Device, describeDevice } from '../domain/device';
import { AuthenticationError } from '../domain/identity-policy';
import type { UserRecord } from '../domain/identity-records';

import { IDENTITY_STORE, type IdentityStore } from './identity-store';
import type { SecurityContext } from './mfa-commands';

/** A session of the account, as its owner sees it in Profile → Sessions. */
export interface AccountSession {
  readonly id: string;
  /** The session that made this request. */
  readonly current: boolean;
  readonly device: Device;
  readonly ip: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

/**
 * The account's own sessions (issue #253): listing them, and ending another one, which then
 * answers 401. The current session is ended by signing out. Each revocation is audited as
 * `identity.session_revoked`, with the account as actor and no organization.
 */
@Injectable()
export class AccountSessionCommands {
  constructor(
    @Inject(IDENTITY_STORE) private readonly users: IdentityStore,
    private readonly events: DomainEventBus,
  ) {}

  list(
    context: SecurityContext,
    currentSessionId: string,
    now = new Date(),
  ): Promise<AccountSession[]> {
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      const sessions = await this.users.activeSessions(user.id, user.securityVersion, now);
      return sessions.map((session) => ({
        id: session.id,
        current: session.id === currentSessionId,
        device: describeDevice(session.userAgent),
        ip: session.ip,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      }));
    });
  }

  revoke(
    context: SecurityContext,
    currentSessionId: string,
    sessionId: string,
    now = new Date(),
  ): Promise<void> {
    if (sessionId === currentSessionId)
      throw new ConflictError('session_current', 'Sign out to end the session you are using.');
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      // Another account's session, an ended one and an unknown id answer the same.
      if (!(await this.users.revokeSessionById(user.id, sessionId, now)))
        throw new NotFoundError('session');
      await this.events.publish([
        createEvent({
          type: 'identity.session_revoked',
          actor: { kind: 'user', id: context.userId, ip: context.ip },
          target: { type: 'session', id: sessionId },
          payload: {},
          occurredAt: now,
        }),
      ]);
    });
  }
}

function assertContext(user: UserRecord, context: SecurityContext): void {
  if (user.status !== 'active' || user.securityVersion !== context.securityVersion)
    throw new AuthenticationError();
}

import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, createEvent, NotFoundError } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { type Device, describeDevice } from '../domain/device';
import { AuthenticationError } from '../domain/identity-policy';
import type { UserRecord } from '../domain/identity-records';

import { IDENTITY_STORE, type IdentityStore } from './identity-store';
import type { SecurityContext } from './mfa-commands';

/** Sessions listed at most; the others are still ended by "sign out every other session". */
const LISTED = 100;

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

  /**
   * The 100 most recently active sessions; `truncated` says there are more, which "sign out every
   * other session" ends as well.
   */
  list(
    context: SecurityContext,
    currentSessionId: string,
    now = new Date(),
  ): Promise<{ items: AccountSession[]; truncated: boolean }> {
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      const found = await this.users.activeSessions(user.id, user.securityVersion, now, LISTED + 1);
      const items = found.slice(0, LISTED).map((session) => ({
        id: session.id,
        current: session.id === currentSessionId,
        device: describeDevice(session.userAgent),
        ip: session.ip,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
      }));
      return { items, truncated: found.length > LISTED };
    });
  }

  /** Ends every other live session of the account, listed or not; audited once with the count. */
  revokeOthers(
    context: SecurityContext,
    currentSessionId: string,
    now = new Date(),
  ): Promise<number> {
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      const count = await this.users.revokeOtherSessions(user.id, currentSessionId, now);
      if (count > 0)
        await this.events.publish([
          createEvent({
            type: 'identity.sessions_revoked',
            actor: { kind: 'user', id: context.userId, ip: context.ip },
            target: { type: 'user', id: user.id },
            payload: { count },
            occurredAt: now,
          }),
        ]);
      return count;
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

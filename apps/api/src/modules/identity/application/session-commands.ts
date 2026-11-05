import { Inject, Injectable } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { identityEvent } from '../domain/identity-events';
import {
  AuthenticationError,
  normalizeEmail,
  SESSION_ABSOLUTE_MS,
  sessionIsLive,
  TOKEN_PATTERN,
} from '../domain/identity-policy';
import type { SessionRecord, UserRecord } from '../domain/identity-records';

import {
  IDENTITY_SECRETS,
  type IdentitySecrets,
  PASSWORD_HASHER,
  type PasswordHashing,
} from './identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './identity-store';

export interface SessionGrant {
  readonly userId: string;
  readonly email: string;
  readonly token: Secret;
  readonly csrf: Secret;
  readonly expiresAt: Date;
}

@Injectable()
export class SessionCommands {
  constructor(
    @Inject(IDENTITY_STORE) private readonly store: IdentityStore,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHashing,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    private readonly events: DomainEventBus,
  ) {}

  async login(
    input: {
      email: string;
      password: Secret;
      ip: string;
      userAgent: string;
      previous?: Secret;
    },
    now = new Date(),
  ): Promise<SessionGrant> {
    const user = await this.store.findUserByEmail(normalizeEmail(input.email));
    const matched = await this.passwords.verify(user?.passwordHash, input.password);
    if (!user || !matched || user.status !== 'active') throw new AuthenticationError();
    return this.store.withUserLock(user.id, async (current) => {
      // A password reset between verification and this lock must invalidate the proof.
      if (current.securityVersion !== user.securityVersion || current.status !== 'active')
        throw new AuthenticationError();
      const token = this.secrets.issue();
      const csrf = this.secrets.issue();
      const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
      await this.store.insertSession({
        id: uuidv7(),
        userId: current.id,
        tokenHash: this.secrets.hash('session', token),
        csrfHash: this.secrets.hash('csrf', csrf),
        securityVersion: current.securityVersion,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        expiresAt,
        revokedAt: null,
        ip: input.ip,
        userAgent: input.userAgent.slice(0, 512),
      });
      if (input.previous)
        await this.store.revokeSession(
          current.id,
          this.secrets.hash('session', input.previous),
          now,
        );
      await this.events.publish([
        identityEvent('logged_in', current.id, { kind: 'user', id: current.id, ip: input.ip }, now),
      ]);
      return { userId: current.id, email: current.email, token, csrf, expiresAt };
    });
  }

  async authenticate(
    token: Secret,
    csrf?: Secret,
    now = new Date(),
  ): Promise<{ user: UserRecord; session: SessionRecord }> {
    if (!TOKEN_PATTERN.test(token.expose())) throw new AuthenticationError();
    const record = await this.store.findSession(this.secrets.hash('session', token));
    if (
      !record ||
      record.user.status !== 'active' ||
      record.user.securityVersion !== record.session.securityVersion ||
      !sessionIsLive(record.session, now) ||
      (csrf !== undefined &&
        (!TOKEN_PATTERN.test(csrf.expose()) ||
          !this.secrets.matches('csrf', csrf, record.session.csrfHash))) ||
      !(await this.store.touchSession(record.session.id, now))
    )
      throw new AuthenticationError();
    return record;
  }

  async logout(userId: string, token: Secret, now = new Date()): Promise<void> {
    await this.store.withUserLock(userId, async () => {
      if (await this.store.revokeSession(userId, this.secrets.hash('session', token), now)) {
        await this.events.publish([
          identityEvent('logged_out', userId, { kind: 'user', id: userId }, now),
        ]);
      }
    });
  }
}

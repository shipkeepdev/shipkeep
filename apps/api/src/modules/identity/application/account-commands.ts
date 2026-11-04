import { Inject, Injectable } from '@nestjs/common';
import { Secret, SYSTEM_ACTOR } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { identityEvent } from '../domain/identity-events';
import {
  assertPassword,
  AuthenticationError,
  EMAIL_TOKEN_MS,
  normalizeEmail,
  RESET_TOKEN_MS,
  TOKEN_PATTERN,
} from '../domain/identity-policy';

import {
  IDENTITY_MAILER,
  type IdentityMailer,
  IDENTITY_SECRETS,
  type IdentitySecrets,
  PASSWORD_HASHER,
  type PasswordHashing,
} from './identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './identity-store';

@Injectable()
export class AccountCommands {
  constructor(
    @Inject(IDENTITY_STORE) private readonly store: IdentityStore,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHashing,
    @Inject(IDENTITY_SECRETS) private readonly secrets: IdentitySecrets,
    @Inject(IDENTITY_MAILER) private readonly mailer: IdentityMailer,
    private readonly events: DomainEventBus,
  ) {}

  async register(emailInput: string, password: Secret, now = new Date()): Promise<void> {
    const email = normalizeEmail(emailInput);
    // Hash even for duplicates: neither status nor expensive hashing reveals account existence.
    const passwordHash = await this.passwords.hash(password);
    const id = uuidv7();
    const token = this.secrets.issue();
    const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_MS);
    await this.store.transaction(async () => {
      const created = await this.store.insertUser({
        id,
        email,
        passwordHash,
        status: 'pending',
        emailVerifiedAt: null,
        securityVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
      if (!created) return false;
      await this.store.insertToken({
        id: uuidv7(),
        userId: id,
        purpose: 'verify',
        tokenHash: this.secrets.hash('verify', token),
        securityVersion: 0,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        usedAt: null,
      });
      await this.events.publish([identityEvent('registered', id, SYSTEM_ACTOR, now)]);
      await this.mailer.send({ email, purpose: 'verify', token, expiresAt });
      return true;
    });
  }

  async requestEmail(
    emailInput: string,
    purpose: 'verify' | 'reset',
    now = new Date(),
  ): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.store.findUserByEmail(email);
    if (!user) return;
    const token = this.secrets.issue();
    const expiresAt = new Date(
      now.getTime() + (purpose === 'verify' ? EMAIL_TOKEN_MS : RESET_TOKEN_MS),
    );
    await this.store.withUserLock(user.id, async (current) => {
      if (current.status !== (purpose === 'verify' ? 'pending' : 'active')) return false;
      // Reissuing does not invalidate a link already in transit. Each token remains single-use;
      // successful verification/reset invalidates every outstanding credential of its purpose.
      await this.store.insertToken({
        id: uuidv7(),
        userId: user.id,
        purpose,
        tokenHash: this.secrets.hash(purpose, token),
        securityVersion: current.securityVersion,
        createdAt: now,
        updatedAt: now,
        expiresAt,
        usedAt: null,
      });
      await this.events.publish([
        identityEvent(`${purpose}_requested`, user.id, SYSTEM_ACTOR, now),
      ]);
      await this.mailer.send({ email, purpose, token, expiresAt });
      return true;
    });
  }

  async verifyEmail(value: Secret, now = new Date()): Promise<void> {
    const token = await this.credential(value, 'verify');
    await this.store.withUserLock(token.userId, async (user) => {
      if (
        user.status !== 'pending' ||
        token.securityVersion !== user.securityVersion ||
        !(await this.store.consumeToken(token.id, now))
      )
        throw new AuthenticationError();
      await this.store.activateUser(user.id, now);
      await this.store.invalidateTokens(user.id, 'verify', now);
      await this.events.publish([identityEvent('email_verified', user.id, SYSTEM_ACTOR, now)]);
    });
  }

  async resetPassword(value: Secret, password: Secret, now = new Date()): Promise<void> {
    assertPassword(password.expose());
    const token = await this.credential(value, 'reset');
    const passwordHash = await this.passwords.hash(password);
    await this.store.withUserLock(token.userId, async (user) => {
      if (
        user.status !== 'active' ||
        token.securityVersion !== user.securityVersion ||
        !(await this.store.consumeToken(token.id, now))
      )
        throw new AuthenticationError();
      await this.store.changePassword(user.id, passwordHash, now);
      await this.events.publish([identityEvent('password_reset', user.id, SYSTEM_ACTOR, now)]);
    });
  }

  private async credential(value: Secret, purpose: 'verify' | 'reset') {
    if (!TOKEN_PATTERN.test(value.expose())) throw new AuthenticationError();
    const token = await this.store.findToken(this.secrets.hash(purpose, value));
    if (!token || token.purpose !== purpose) throw new AuthenticationError();
    return token;
  }
}

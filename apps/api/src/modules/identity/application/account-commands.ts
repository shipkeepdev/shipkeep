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
      // A pending account may also be reset: the mailbox owner can always claim an address that
      // someone else registered first (pre-hijacking defence).
      const eligible =
        purpose === 'verify'
          ? current.status === 'pending'
          : current.status === 'active' || current.status === 'pending';
      if (!eligible) return false;
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

  /**
   * Activates a pending account. The link proves the mailbox; the password proves the person who
   * clicks it is the one who registered. Without it, an attacker could register someone else's
   * address with their own password and wait for the owner to click the link (account
   * pre-hijacking). An owner who never chose that password uses the reset flow instead.
   */
  async verifyEmail(value: Secret, password: Secret, now = new Date()): Promise<void> {
    const token = await this.credential(value, 'verify');
    const registered = await this.store.findUser(token.userId);
    // Hash work happens before the user lock and outside any transaction.
    const matched = await this.passwords.verify(registered?.passwordHash, password);
    if (!registered || !matched) throw new AuthenticationError();
    await this.store.withUserLock(token.userId, async (user) => {
      if (
        user.status !== 'pending' ||
        token.securityVersion !== user.securityVersion ||
        // The password checked above must still be the stored one.
        user.passwordHash.expose() !== registered.passwordHash.expose() ||
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
        (user.status !== 'active' && user.status !== 'pending') ||
        token.securityVersion !== user.securityVersion ||
        !(await this.store.consumeToken(token.id, now))
      )
        throw new AuthenticationError();
      const events = [identityEvent('password_reset', user.id, SYSTEM_ACTOR, now)];
      if (user.status === 'pending') {
        // The reset link proves the mailbox and the owner chose the password: activate.
        await this.store.activateUser(user.id, now);
        await this.store.invalidateTokens(user.id, 'verify', now);
        events.unshift(identityEvent('email_verified', user.id, SYSTEM_ACTOR, now));
      }
      // Advances the security version: sessions and links issued before the reset stop working.
      await this.store.changePassword(user.id, passwordHash, now);
      await this.events.publish(events);
    });
  }

  private async credential(value: Secret, purpose: 'verify' | 'reset') {
    if (!TOKEN_PATTERN.test(value.expose())) throw new AuthenticationError();
    const token = await this.store.findToken(this.secrets.hash(purpose, value));
    if (!token || token.purpose !== purpose) throw new AuthenticationError();
    return token;
  }
}

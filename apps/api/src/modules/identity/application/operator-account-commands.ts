import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, type Secret, SYSTEM_ACTOR } from '@shipkeep/domain';
import { v7 as uuidv7 } from 'uuid';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { identityEvent } from '../domain/identity-events';
import { assertPassword, normalizeEmail } from '../domain/identity-policy';

import { PASSWORD_HASHER, type PasswordHashing } from './identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './identity-store';

/**
 * Accounts created and recovered on the server that runs the control plane (ADR 0020), for an
 * installation that sends no email. No route reaches these commands: they run from the command
 * line of the control plane (`operator.ts`), by someone who already holds the database and the
 * key-encryption key.
 */
@Injectable()
export class OperatorAccountCommands {
  constructor(
    @Inject(IDENTITY_STORE) private readonly store: IdentityStore,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHashing,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Creates an account that can sign in at once. Its address is confirmed by the operator of the
   * installation instead of by its mailbox: nothing checks that the mailbox exists.
   */
  async create(
    emailInput: string,
    password: Secret,
    now = new Date(),
  ): Promise<{ id: string; email: string }> {
    assertPassword(password.expose());
    const email = normalizeEmail(emailInput);
    const passwordHash = await this.passwords.hash(password);
    const id = uuidv7();
    const created = await this.store.transaction(async () => {
      const inserted = await this.store.insertUser({
        id,
        email,
        passwordHash,
        status: 'active',
        emailVerifiedAt: now,
        securityVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
      if (!inserted) return false;
      await this.events.publish([identityEvent('created_by_operator', id, SYSTEM_ACTOR, now)]);
      return true;
    });
    // Unlike the public sign-up, this says so: the operator must know nothing was changed.
    if (!created)
      throw new ConflictError('account_exists', 'An account with this address already exists.');
    return { id, email };
  }

  /**
   * Gives an account a new password. Its sessions, its API tokens and the links it was sent stop
   * working, and an account that never confirmed its address becomes active. A second factor
   * stays as it is: its recovery codes are the way back.
   */
  async resetPassword(emailInput: string, password: Secret, now = new Date()): Promise<string> {
    assertPassword(password.expose());
    const email = normalizeEmail(emailInput);
    const found = await this.store.findUserByEmail(email);
    if (!found) throw new NotFoundError('Account');
    const passwordHash = await this.passwords.hash(password);
    await this.store.withUserLock(found.id, async (user) => {
      if (user.status === 'disabled')
        throw new ConflictError('account_disabled', 'This account is disabled.');
      if (user.status === 'pending') {
        await this.store.activateUser(user.id, now);
        await this.store.invalidateTokens(user.id, 'verify', now);
      }
      // Advances the security version: what was issued before the reset stops working.
      await this.store.changePassword(user.id, passwordHash, now);
      await this.events.publish([
        identityEvent('password_reset_by_operator', user.id, SYSTEM_ACTOR, now),
      ]);
    });
    return email;
  }
}

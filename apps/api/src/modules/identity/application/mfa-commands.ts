import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, Secret } from '@shipkeep/domain';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { identityEvent } from '../domain/identity-events';
import { AuthenticationError } from '../domain/identity-policy';
import type { UserRecord } from '../domain/identity-records';

import { PASSWORD_HASHER, type PasswordHashing } from './identity-ports';
import { IDENTITY_STORE, type IdentityStore } from './identity-store';
import { MFA_CRYPTO, type MfaCrypto, type MfaProofInput } from './mfa-crypto';
import { MfaProof } from './mfa-proof';
import { MFA_STORE, type MfaStore } from './mfa-store';
import { SessionCommands, type SessionGrant } from './session-commands';

export interface SecurityContext {
  readonly userId: string;
  readonly securityVersion: number;
  readonly ip: string;
  readonly userAgent: string;
}
export interface RecoveryGrant {
  readonly session: SessionGrant;
  readonly recoveryCodes: readonly Secret[];
}

@Injectable()
export class MfaCommands {
  constructor(
    @Inject(IDENTITY_STORE) private readonly users: IdentityStore,
    @Inject(MFA_STORE) private readonly mfa: MfaStore,
    @Inject(MFA_CRYPTO) private readonly crypto: MfaCrypto,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHashing,
    private readonly proof: MfaProof,
    private readonly sessions: SessionCommands,
    private readonly events: DomainEventBus,
  ) {}

  async setup(
    context: SecurityContext,
    password: Secret,
    now = new Date(),
  ): Promise<{ secret: Secret; uri: Secret; expiresAt: Date }> {
    await this.reauthenticate(context, password);
    const secret = this.crypto.seed();
    const ciphertext = await this.crypto.encrypt(context.userId, secret);
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      if (!(await this.mfa.stage(user.id, ciphertext, user.securityVersion, now)))
        throw new ConflictError(
          'mfa_already_enabled',
          'Disable the existing second factor before enrolling another.',
        );
      await this.audit('mfa_setup_requested', context, now);
      return {
        secret,
        uri: this.crypto.uri(secret, user.email),
        expiresAt: new Date(now.getTime() + 600000),
      };
    });
  }

  async enable(
    context: SecurityContext,
    password: Secret,
    code: Secret,
    now = new Date(),
  ): Promise<RecoveryGrant> {
    await this.reauthenticate(context, password);
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      const state = await this.mfa.find(user.id);
      if (!state?.pendingCiphertext || state.pendingVersion !== user.securityVersion)
        throw new AuthenticationError();
      const secret = await this.crypto.decrypt(user.id, state.pendingCiphertext);
      const counter = this.crypto.counter(secret, code, now, null);
      if (counter === null || !(await this.mfa.activate(user.id, counter, now)))
        throw new AuthenticationError();
      const recoveryCodes = await this.replaceRecovery(user.id, now);
      const session = await this.sessions.rotateAuthenticated(
        user.id,
        user.securityVersion,
        context,
        now,
      );
      await this.audit('mfa_enabled', context, now);
      return { session, recoveryCodes };
    });
  }

  async disable(
    context: SecurityContext,
    password: Secret,
    proof: MfaProofInput,
    now = new Date(),
  ): Promise<SessionGrant> {
    await this.reauthenticate(context, password);
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      await this.requireActiveProof(user.id, proof, now);
      await this.mfa.remove(user.id);
      const session = await this.sessions.rotateAuthenticated(
        user.id,
        user.securityVersion,
        context,
        now,
      );
      await this.audit('mfa_disabled', context, now);
      return session;
    });
  }

  async regenerateRecovery(
    context: SecurityContext,
    password: Secret,
    proof: MfaProofInput,
    now = new Date(),
  ): Promise<RecoveryGrant> {
    await this.reauthenticate(context, password);
    return this.users.withUserLock(context.userId, async (user) => {
      assertContext(user, context);
      await this.requireActiveProof(user.id, proof, now);
      const recoveryCodes = await this.replaceRecovery(user.id, now);
      const session = await this.sessions.rotateAuthenticated(
        user.id,
        user.securityVersion,
        context,
        now,
      );
      await this.audit('mfa_recovery_regenerated', context, now);
      return { session, recoveryCodes };
    });
  }

  private async reauthenticate(context: SecurityContext, password: Secret): Promise<void> {
    const user = await this.users.findUser(context.userId);
    const matched = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !matched) throw new AuthenticationError();
    assertContext(user, context);
  }
  private async requireActiveProof(userId: string, proof: MfaProofInput, now: Date): Promise<void> {
    if (!(await this.mfa.find(userId))?.activeCiphertext) throw new AuthenticationError();
    await this.proof.verify(userId, proof, now);
  }
  private async replaceRecovery(userId: string, now: Date): Promise<Secret[]> {
    const codes = this.crypto.recoveryCodes();
    await this.mfa.replaceRecovery(
      userId,
      codes.map((code) => this.crypto.recoveryHash(code)),
      now,
    );
    return codes;
  }
  private async audit(action: string, context: SecurityContext, now: Date): Promise<void> {
    await this.events.publish([
      identityEvent(
        action,
        context.userId,
        { kind: 'user', id: context.userId, ip: context.ip },
        now,
      ),
    ]);
  }
}

function assertContext(user: UserRecord, context: SecurityContext): void {
  if (user.status !== 'active' || user.securityVersion !== context.securityVersion)
    throw new AuthenticationError();
}

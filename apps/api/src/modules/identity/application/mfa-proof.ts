import { Inject, Injectable } from '@nestjs/common';

import { DomainEventBus } from '../../../platform/events/domain-event-bus';
import { identityEvent } from '../domain/identity-events';
import { AuthenticationError } from '../domain/identity-policy';

import { MFA_CRYPTO, type MfaCrypto, type MfaProofInput } from './mfa-crypto';
import { MFA_STORE, type MfaStore } from './mfa-store';

@Injectable()
export class MfaProof {
  constructor(
    @Inject(MFA_STORE) private readonly store: MfaStore,
    @Inject(MFA_CRYPTO) private readonly crypto: MfaCrypto,
    private readonly events: DomainEventBus,
  ) {}

  /** Caller holds the user lock; proof consumption rolls back with the authenticated command. */
  async verify(userId: string, proof: MfaProofInput | undefined, now: Date): Promise<void> {
    const state = await this.store.find(userId);
    if (!state?.activeCiphertext) return;
    if (!proof || Boolean(proof.totp) === Boolean(proof.recovery)) throw new AuthenticationError();
    if (proof.totp) {
      const secret = await this.crypto.decrypt(userId, state.activeCiphertext);
      const counter = this.crypto.counter(secret, proof.totp, now, state.lastCounter);
      if (counter === null || !(await this.store.claimCounter(userId, counter, now)))
        throw new AuthenticationError();
      return;
    }
    const code = proof.recovery;
    if (
      !code ||
      !/^[a-f0-9]{32}$/.test(code.expose()) ||
      !(await this.store.claimRecovery(userId, this.crypto.recoveryHash(code), now))
    )
      throw new AuthenticationError();
    await this.events.publish([
      identityEvent('mfa_recovery_used', userId, { kind: 'user', id: userId }, now),
    ]);
  }
}

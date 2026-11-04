import { Inject, Injectable } from '@nestjs/common';

import type { SecurityContext } from './mfa-commands';
import { MFA_STORE, type MfaStore } from './mfa-store';

@Injectable()
export class MfaQuery {
  constructor(@Inject(MFA_STORE) private readonly store: MfaStore) {}

  async status(
    context: Pick<SecurityContext, 'userId' | 'securityVersion'>,
    now = new Date(),
  ): Promise<{
    enabled: boolean;
    pendingExpiresAt: string | null;
    recoveryCodesRemaining: number;
  }> {
    const state = await this.store.find(context.userId);
    const enabled = Boolean(state?.activeCiphertext);
    const pending =
      state?.pendingVersion === context.securityVersion &&
      state.pendingExpiresAt &&
      state.pendingExpiresAt > now;
    return {
      enabled,
      pendingExpiresAt: pending ? state.pendingExpiresAt.toISOString() : null,
      recoveryCodesRemaining: enabled ? await this.store.remainingRecovery(context.userId) : 0,
    };
  }
}

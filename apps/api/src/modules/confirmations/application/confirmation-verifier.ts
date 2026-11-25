import { Inject, Injectable } from '@nestjs/common';
import type { Secret } from '@shipkeep/domain';

import {
  CONFIRMATION_KEY_PROVIDER,
  type ConfirmationKeyProvider,
} from '../../fleet/application/ports';
import {
  claimsMatch,
  ConfirmationRejectedError,
  type ConfirmationRequest,
  parseConfirmationToken,
} from '../domain/confirmation-token';

import { CONFIRMATION_STORE, type ConfirmationStore } from './ports';

/**
 * Consumes a confirmation token for one destructive request. Call it inside the destructive
 * command's tenant transaction, after its permission check: the token is spent only if that
 * transaction commits. Returns the token id for the command's audit event.
 */
@Injectable()
export class ConfirmationVerifier {
  constructor(
    @Inject(CONFIRMATION_STORE) private readonly store: ConfirmationStore,
    @Inject(CONFIRMATION_KEY_PROVIDER) private readonly keys: ConfirmationKeyProvider,
  ) {}

  async consume(
    token: Secret,
    request: ConfirmationRequest,
    userId: string,
    now = new Date(),
  ): Promise<string> {
    const id = await this.verified(token, request, userId, now);
    if (!(await this.store.consume(id, request, userId, now)))
      throw new ConfirmationRejectedError();
    return id;
  }

  /**
   * Checks the token as `consume` does, without spending it: for a destructive command that does
   * part of its work first and spends the token only when it completes (#474).
   */
  async check(
    token: Secret,
    request: ConfirmationRequest,
    userId: string,
    now = new Date(),
  ): Promise<void> {
    const id = await this.verified(token, request, userId, now);
    if (!(await this.store.usable(id, request, userId, now))) throw new ConfirmationRejectedError();
  }

  /** The token's id once its signature and claims hold for this request. */
  private async verified(
    token: Secret,
    request: ConfirmationRequest,
    userId: string,
    now: Date,
  ): Promise<string> {
    const parsed = parseConfirmationToken(token.expose());
    if (
      !parsed ||
      !claimsMatch(parsed.claims, request, userId, now) ||
      !(await this.keys.verifyConfirmation(
        Buffer.from(parsed.signingInput, 'utf8'),
        parsed.signature,
      ))
    )
      throw new ConfirmationRejectedError();
    return parsed.claims.jti;
  }
}

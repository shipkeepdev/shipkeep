import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';

import { EnvelopeService } from '../../../platform/crypto/envelope.service';
import type { MfaCrypto } from '../application/mfa-crypto';

import { hashToken, matchTotp, newTotpSecret, recoveryCodes, totpUri } from './identity-secrets';

@Injectable()
export class EnvelopeMfaCrypto implements MfaCrypto {
  constructor(private readonly envelope: EnvelopeService) {}
  seed(): Secret {
    return newTotpSecret();
  }
  uri(seed: Secret, email: string): Secret {
    return totpUri(seed, email);
  }
  recoveryCodes(): Secret[] {
    return recoveryCodes();
  }
  recoveryHash(code: Secret): string {
    return hashToken('recovery', code);
  }
  counter(seed: Secret, code: Secret, now: Date, last: number | null): number | null {
    return matchTotp(seed, code.expose(), now.getTime(), last);
  }
  async encrypt(userId: string, secret: Secret): Promise<Uint8Array> {
    const bytes = Buffer.from(secret.expose());
    try {
      return new Uint8Array(
        await this.envelope.encryptFor('identity:mfa', `totp:${userId}`, bytes),
      );
    } catch {
      throw new ServiceUnavailableException('Second factor temporarily unavailable.');
    } finally {
      bytes.fill(0);
    }
  }
  async decrypt(userId: string, ciphertext: Uint8Array): Promise<Secret> {
    try {
      const bytes = await this.envelope.decryptFor(
        'identity:mfa',
        `totp:${userId}`,
        Buffer.from(ciphertext),
      );
      try {
        const value = bytes.toString('utf8');
        if (!/^[A-Z2-7]{32}$/.test(value)) throw new Error('invalid seed');
        return new Secret(value);
      } finally {
        bytes.fill(0);
      }
    } catch {
      throw new ServiceUnavailableException('Second factor temporarily unavailable.');
    }
  }
}

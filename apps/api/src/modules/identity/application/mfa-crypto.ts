import type { Secret } from '@shipkeep/domain';

export interface MfaProofInput {
  readonly totp?: Secret;
  readonly recovery?: Secret;
}
export const MFA_CRYPTO = Symbol('MfaCrypto');
export interface MfaCrypto {
  seed(): Secret;
  encrypt(userId: string, secret: Secret): Promise<Uint8Array>;
  decrypt(userId: string, ciphertext: Uint8Array): Promise<Secret>;
  counter(secret: Secret, code: Secret, now: Date, last: number | null): number | null;
  uri(secret: Secret, email: string): Secret;
  recoveryCodes(): Secret[];
  recoveryHash(code: Secret): string;
}

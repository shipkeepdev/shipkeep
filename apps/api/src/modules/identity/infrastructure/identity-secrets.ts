import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Secret } from '@shipkeep/domain';
import * as OTPAuth from 'otpauth';

export type TokenPurpose = 'session' | 'csrf' | 'verify' | 'reset' | 'api' | 'recovery';

export function matchesTokenHash(
  purpose: TokenPurpose,
  value: Secret,
  expectedHash: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return timingSafeEqual(
    Buffer.from(hashToken(purpose, value), 'hex'),
    Buffer.from(expectedHash, 'hex'),
  );
}

export function issueToken(): Secret {
  return new Secret(randomBytes(32).toString('base64url'));
}

export function hashToken(purpose: TokenPurpose, value: Secret): string {
  return createHash('sha256').update(`shipkeep:${purpose}:`).update(value.expose()).digest('hex');
}

export function newTotpSecret(): Secret {
  return new Secret(new OTPAuth.Secret({ size: 20 }).base32);
}

function totp(secret: Secret, label = 'account'): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'Shipkeep',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret.expose()),
  });
}

/** Returns a counter to claim atomically in storage, never an authorization decision by itself. */
export function matchTotp(
  secret: Secret,
  code: string,
  nowMs: number,
  lastCounter: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(secret).validate({ token: code, timestamp: nowMs, window: 1 });
  if (delta === null) return null;
  const counter = Math.floor(nowMs / 30_000) + delta;
  return counter > (lastCounter ?? -1) ? counter : null;
}

/** The URI is a secret delivered in a no-store response, never a redirect or a log field. */
export function totpUri(secret: Secret, email: string): Secret {
  return new Secret(totp(secret, email).toString());
}

export function recoveryCodes(): Secret[] {
  return Array.from({ length: 10 }, () => new Secret(randomBytes(16).toString('hex')));
}

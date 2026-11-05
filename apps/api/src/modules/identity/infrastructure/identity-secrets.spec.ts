import { Secret } from '@shipkeep/domain';
import * as OTPAuth from 'otpauth';

import {
  hashToken,
  issueToken,
  matchTotp,
  newTotpSecret,
  recoveryCodes,
  totpUri,
} from './identity-secrets';
import { PasswordHasher } from './password-hasher';

describe('identity secrets', () => {
  it('issues independent 256-bit tokens and stores purpose-bound hashes', () => {
    const first = issueToken();
    expect(first.expose()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.expose()).not.toBe(issueToken().expose());
    expect(JSON.stringify(first)).not.toContain(first.expose());
    expect(hashToken('session', first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken('session', first)).not.toBe(hashToken('reset', first));
    expect(hashToken('session', first)).toBe(hashToken('session', first));
  });
  it('uses salted Argon2id and performs equivalent work for unknown accounts', async () => {
    const hasher = new PasswordHasher();
    const password = new Secret('long enough test password');
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);
    expect(first.expose()).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(first.expose()).not.toBe(second.expose());
    expect(await hasher.verify(first, password)).toBe(true);
    expect(await hasher.verify(first, new Secret('incorrect password'))).toBe(false);
    expect(await hasher.verify(undefined, password)).toBe(false);
    expect(await hasher.verify(new Secret('invalid hash'), password)).toBe(false);
  });
  it('validates RFC 6238 SHA-1 codes with a bounded window and rejects replays', () => {
    const secret = new Secret(OTPAuth.Secret.fromUTF8('12345678901234567890').base32);
    expect(matchTotp(secret, '287082', 59_000, null)).toBe(1);
    expect(matchTotp(secret, '287082', 59_000, 1)).toBeNull();
    expect(matchTotp(secret, '287082', 89_000, null)).toBe(1);
    expect(matchTotp(secret, '287082', 119_000, null)).toBeNull();
    for (const value of ['287082\n', '0287082', 'abc123', '']) {
      expect(matchTotp(secret, value, 59_000, null)).toBeNull();
    }
  });
  it('generates distinct enrollment secrets and ten 128-bit recovery codes', () => {
    const secret = newTotpSecret();
    expect(secret.expose()).toMatch(/^[A-Z2-7]{32}$/);
    expect(secret.expose()).not.toBe(newTotpSecret().expose());
    expect(totpUri(secret, 'person@example.com').expose()).toContain('issuer=Shipkeep');
    const codes = recoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes.map((code) => code.expose())).size).toBe(10);
    for (const code of codes) expect(code.expose()).toMatch(/^[a-f0-9]{32}$/);
  });
});

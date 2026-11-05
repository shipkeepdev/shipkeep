import {
  assertPassword,
  normalizeEmail,
  sessionIsLive,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from './identity-policy';

describe('identity policy', () => {
  it('normalizes email identity without accepting ambiguous addresses', () => {
    expect(normalizeEmail(' Person@EXAMPLE.COM ')).toBe('person@example.com');
    for (const value of [
      'a@b',
      'a\n@example.com',
      'a@b@c.com',
      '.a@example.com',
      'a..b@example.com',
      'a@-example.com',
      'a@éxample.com',
      'a'.repeat(65) + '@example.com',
    ]) {
      expect(() => normalizeEmail(value)).toThrow();
    }
  });
  it('accepts long Unicode passphrases without trimming or composition requirements', () => {
    expect(() => {
      assertPassword('all lower case words');
    }).not.toThrow();
    expect(() => {
      assertPassword('🔐'.repeat(15));
    }).not.toThrow();
    expect(() => {
      assertPassword(' '.repeat(15));
    }).not.toThrow();
    for (const value of ['short', 'a'.repeat(129), 'a'.repeat(15) + '\0']) {
      expect(() => {
        assertPassword(value);
      }).toThrow();
    }
  });
  it('expires exactly at either session boundary, even after recent use', () => {
    const createdAt = new Date(0);
    expect(
      sessionIsLive(
        { createdAt, lastSeenAt: createdAt, revokedAt: null },
        new Date(SESSION_IDLE_MS - 1),
      ),
    ).toBe(true);
    expect(
      sessionIsLive(
        { createdAt, lastSeenAt: createdAt, revokedAt: null },
        new Date(SESSION_IDLE_MS),
      ),
    ).toBe(false);
    expect(
      sessionIsLive(
        { createdAt, lastSeenAt: new Date(SESSION_ABSOLUTE_MS - 1), revokedAt: null },
        new Date(SESSION_ABSOLUTE_MS),
      ),
    ).toBe(false);
    expect(
      sessionIsLive({ createdAt, lastSeenAt: createdAt, revokedAt: createdAt }, createdAt),
    ).toBe(false);
    expect(sessionIsLive({ createdAt, lastSeenAt: createdAt, revokedAt: null }, new Date(-1))).toBe(
      false,
    );
  });
});

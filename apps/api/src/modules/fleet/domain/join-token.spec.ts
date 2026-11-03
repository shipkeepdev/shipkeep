import {
  evaluateJoinToken,
  generateJoinTokenValue,
  hashJoinToken,
  isWellFormedJoinToken,
  JOIN_TOKEN_TTL_MS,
  type JoinTokenRecord,
} from './join-token';

const now = new Date('2026-11-03T12:00:00Z');

function record(value: string, overrides: Partial<JoinTokenRecord> = {}): JoinTokenRecord {
  return {
    id: 'jt_1',
    organizationId: 'org_1',
    tokenHash: hashJoinToken(value),
    createdBy: 'usr_1',
    createdAt: now,
    expiresAt: new Date(now.getTime() + JOIN_TOKEN_TTL_MS),
    usedAt: null,
    usedByNodeId: null,
    ...overrides,
  };
}

describe('join tokens', () => {
  it('generates 32 random bytes as base64url and hashes them with SHA-256', () => {
    const value = generateJoinTokenValue();
    expect(value).toHaveLength(43);
    expect(isWellFormedJoinToken(value)).toBe(true);
    expect(hashJoinToken(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(generateJoinTokenValue()).not.toBe(value);
  });

  it.each(['', 'short', `${'a'.repeat(43)}=`, 'a'.repeat(44), `${'a'.repeat(42)}+`, "' OR 1=1 --"])(
    'rejects the malformed value %p before any lookup',
    (value) => {
      expect(isWellFormedJoinToken(value)).toBe(false);
      expect(evaluateJoinToken(value, undefined, now)).toEqual({ ok: false, reason: 'malformed' });
    },
  );

  it('accepts a fresh matching token', () => {
    const value = generateJoinTokenValue();
    const rec = record(value);
    expect(evaluateJoinToken(value, rec, now)).toEqual({ ok: true, record: rec });
  });

  it('rejects unknown, mismatching, used and expired tokens', () => {
    const value = generateJoinTokenValue();
    expect(evaluateJoinToken(value, undefined, now)).toEqual({ ok: false, reason: 'unknown' });
    expect(evaluateJoinToken(value, record(generateJoinTokenValue()), now)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(evaluateJoinToken(value, record(value, { usedAt: now }), now)).toEqual({
      ok: false,
      reason: 'used',
    });
    const late = new Date(now.getTime() + JOIN_TOKEN_TTL_MS);
    expect(evaluateJoinToken(value, record(value), late)).toEqual({ ok: false, reason: 'expired' });
  });
});

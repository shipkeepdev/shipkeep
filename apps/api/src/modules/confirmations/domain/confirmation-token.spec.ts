import {
  claimsMatch,
  compactToken,
  confirmationClaims,
  confirmationNameMatches,
  isConfirmableAction,
  parseConfirmationToken,
  signingInput,
} from './confirmation-token';

const org = '019d0000-0000-7000-8000-00000000000a';
const node = '019d0000-0000-7000-8000-00000000000b';
const user = '019d0000-0000-7000-8000-00000000000c';
const jti = '019d0000-0000-7000-8000-00000000000d';
const now = new Date('2026-11-05T12:00:00Z');
const request = { organizationId: org, action: 'node.remove' as const, target: node };
const signature = new Uint8Array(64).fill(7);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(): string {
  return compactToken(
    signingInput(confirmationClaims({ id: jti, request, userId: user, now })),
    signature,
  );
}

describe('confirmation tokens', () => {
  it('round-trips a canonical EdDSA JWT with exactly the SPEC 3.6 claims', () => {
    const value = token();
    const header = value.split('.')[0] ?? '';
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      typ: 'JWT',
    });
    const parsed = parseConfirmationToken(value);
    expect(parsed?.claims).toEqual({
      jti,
      org,
      action: 'node.remove',
      target: node,
      sub: user,
      iat: 1793880000,
      exp: 1793880300,
    });
    expect(Buffer.from(parsed?.signature ?? []).equals(Buffer.from(signature))).toBe(true);
  });

  it('rejects altered, non-canonical, oversized and foreign tokens', () => {
    const [header = '', payload = '', sig = ''] = token().split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    for (const candidate of [
      '',
      'a.b',
      `${header}.${payload}`,
      `${header}.${payload}.${sig}.extra`,
      `${encode({ alg: 'none', typ: 'JWT' })}.${payload}.${sig}`,
      `${encode({ typ: 'JWT', alg: 'EdDSA' })}.${payload}.${sig}`,
      `${header}.${encode({ ...claims, admin: true })}.${sig}`,
      `${header}.${encode({ ...claims, exp: (claims['exp'] as number) + 3600 })}.${sig}`,
      `${header}.${encode({ ...claims, action: 'organization.delete' })}.${sig}`,
      `${header}.${encode({ ...claims, target: '../../etc/passwd\n' })}.${sig}`,
      `${header}.${Buffer.from(` ${JSON.stringify(claims)}`).toString('base64url')}.${sig}`,
      `${header}.${payload}.${sig.slice(0, -2)}`,
      `${header}.${payload}=.${sig}`,
      `${header}.${payload}.${sig}`.padEnd(3000, 'A'),
    ])
      expect(parseConfirmationToken(candidate), candidate.slice(0, 80)).toBeNull();
  });

  it('matches only its organization, action, target, requester and lifetime', () => {
    const claims = confirmationClaims({ id: jti, request, userId: user, now });
    expect(claimsMatch(claims, request, user, now)).toBe(true);
    expect(claimsMatch(claims, request, user, new Date(now.getTime() + 299_000))).toBe(true);
    for (const [changed, requester, at] of [
      [{ ...request, organizationId: jti }, user, now],
      [{ ...request, target: jti }, user, now],
      [request, jti, now],
      [request, user, new Date(now.getTime() + 300_000)],
      [request, user, new Date(now.getTime() - 61_000)],
    ] as const)
      expect(claimsMatch(claims, changed, requester, at)).toBe(false);
  });

  it('requires the exact resource name and a catalogued action', () => {
    expect(confirmationNameMatches('edge-1', 'edge-1')).toBe(true);
    for (const typed of ['', 'edge-1 ', 'Edge-1', 'edge-'])
      expect(confirmationNameMatches(typed, 'edge-1')).toBe(false);
    expect(isConfirmableAction('node.remove')).toBe(true);
    for (const action of ['toString', '__proto__', 'node.delete', 1])
      expect(isConfirmableAction(action)).toBe(false);
    expect(() => confirmationClaims({ id: 'not-a-uuid', request, userId: user, now })).toThrow(
      'The confirmation is invalid',
    );
  });
});

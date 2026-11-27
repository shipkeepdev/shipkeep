import { describe, expect, it } from 'vitest';

import {
  applicationRepository,
  basicCredentials,
  grantedAccess,
  grantUsername,
  parseGrantUsername,
  requestedScopes,
  tokenClaims,
  wellFormedPassword,
} from './registry-token';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa';
const APP = '0190f5a8-7b1c-7e2d-8f3a-0000000000ab';
const GRANT = '0190f5a8-7b1c-7e2d-8f3a-0000000000ac';
const REPO = `${ORG}/${APP}`;
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('registry grant credentials', () => {
  it('names the organization in the user name, and reads back only that shape', () => {
    expect(grantUsername(ORG, GRANT)).toBe(`${ORG}.${GRANT}`);
    expect(parseGrantUsername(grantUsername(ORG, GRANT))).toEqual({
      organizationId: ORG,
      grantId: GRANT,
    });
    for (const other of [
      ORG,
      `${ORG}.${GRANT}.x`,
      `${ORG.toUpperCase()}.${GRANT}`,
      `../${ORG}.${GRANT}`,
      `${ORG}.${GRANT}\n`,
      `${ORG}' OR '1'='1.${GRANT}`,
      '',
    ])
      expect(parseGrantUsername(other), other).toBeUndefined();
  });

  it('reads a basic header, and nothing else', () => {
    expect(basicCredentials(basic('user', 'p:ss'))).toEqual({ username: 'user', password: 'p:ss' });
    expect(basicCredentials(`basic ${Buffer.from('u:p').toString('base64')}`)).toEqual({
      username: 'u',
      password: 'p',
    });
    for (const other of [
      undefined,
      'Bearer abc',
      'Basic',
      'Basic not base64!',
      `Basic ${Buffer.from('no-colon').toString('base64')}`,
      basic('u', 'x'.repeat(600)),
    ])
      expect(basicCredentials(other), String(other)).toBeUndefined();
  });

  it('accepts only a password of the length and alphabet it issues', () => {
    expect(wellFormedPassword('A'.repeat(43))).toBe(true);
    for (const other of [
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}/`,
    ])
      expect(wellFormedPassword(other), other).toBe(false);
  });
});

describe('registry token scopes', () => {
  it("grants pull on the grant's repository, and push only when it allows it", () => {
    const asked = requestedScopes([`repository:${REPO}:pull,push`]);
    expect(grantedAccess({ organizationId: ORG, applicationId: APP, push: true }, asked)).toEqual([
      { type: 'repository', name: REPO, actions: ['pull', 'push'] },
    ]);
    expect(grantedAccess({ organizationId: ORG, applicationId: APP, push: false }, asked)).toEqual([
      { type: 'repository', name: REPO, actions: ['pull'] },
    ]);
    // `*` is read as pull and push, and is granted no further than the grant.
    expect(
      grantedAccess(
        { organizationId: ORG, applicationId: APP, push: false },
        requestedScopes([`repository:${REPO}:*`]),
      ),
    ).toEqual([{ type: 'repository', name: REPO, actions: ['pull'] }]);
  });

  it("never grants another application's repository, another organization's or the catalog", () => {
    const grant = { organizationId: ORG, applicationId: APP, push: true };
    for (const scope of [
      `repository:${ORG}/0190f5a8-7b1c-7e2d-8f3a-0000000000ff:pull,push`,
      `repository:0190f5a8-7b1c-7e2d-8f3a-0000000000ff/${APP}:pull`,
      `repository:${REPO}/extra:pull`,
      `repository:${REPO}/../${APP}:pull`,
      `repository:${ORG}/./${APP}:pull`,
      'registry:catalog:*',
      `repository:${REPO}:delete`,
      `repository:${REPO.toUpperCase()}:pull`,
      `repository:${REPO}:pull\npush`,
    ])
      expect(grantedAccess(grant, requestedScopes([scope])), scope).toEqual([]);
    expect(applicationRepository(ORG, APP)).toBe(REPO);
  });

  it('reads at most eight scopes, of bounded length', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      i < 8 ? 'registry:catalog:*' : `repository:${REPO}:pull`,
    );
    expect(requestedScopes(many)).toEqual([]);
    expect(requestedScopes([`repository:${'a'.repeat(300)}:pull`])).toEqual([]);
  });
});

describe('registry token claims', () => {
  it('last five minutes for the service, never past the grant', () => {
    const now = new Date('2026-11-27T10:00:00Z');
    const iat = now.getTime() / 1000;
    const claims = tokenClaims({
      service: 'cp.example.com',
      subject: 'user',
      access: [],
      id: 'jti',
      now,
      grantExpiresAt: new Date('2026-11-27T11:00:00Z'),
    });
    expect(claims).toEqual({
      iss: 'shipkeep',
      sub: 'user',
      aud: 'cp.example.com',
      exp: iat + 300,
      nbf: iat - 10,
      iat,
      jti: 'jti',
      access: [],
    });
    expect(
      tokenClaims({
        service: 'cp.example.com',
        subject: 'user',
        access: [],
        id: 'jti',
        now,
        grantExpiresAt: new Date('2026-11-27T10:01:00Z'),
      }).exp,
    ).toBe(iat + 60);
  });
});

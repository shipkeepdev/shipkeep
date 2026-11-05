import { Secret } from '@shipkeep/domain';
import type { Request, Response } from 'express';

import {
  assertOrigin,
  cookiePolicy,
  readCredential,
  resourceContext,
  setSessionCookies,
  type IdentityRequest,
} from './session-http';

describe('HTTP session boundary', () => {
  const token = 'A'.repeat(43);
  it('preserves only the authenticated principal and keeps bearer credentials redacted', () => {
    const base = {
      userId: 'user-id',
      email: 'person@example.com',
      securityVersion: 3,
      expiresAt: new Date(),
      token: new Secret(token),
    };
    const input = {
      ip: '127.0.0.1',
      headers: { 'user-agent': 'Fixture' },
      body: { userId: 'forged', apiCredential: { id: 'forged', value: token } },
    } as IdentityRequest;
    expect(() => resourceContext(input)).toThrow('Authentication failed.');
    input.identity = { ...base, kind: 'session', sessionId: 'session-id' };
    expect(resourceContext(input)).toEqual({
      userId: base.userId,
      securityVersion: 3,
      ip: '127.0.0.1',
      userAgent: 'Fixture',
    });
    input.identity = { ...base, kind: 'api_token', tokenId: 'token-id' };
    const context = resourceContext(input);
    expect(context.apiCredential?.id).toBe('token-id');
    expect(context.apiCredential?.value).toBe(base.token);
    expect(JSON.stringify(context)).not.toContain(token);
  });
  it('requires a unique, canonical cookie value', () => {
    expect(
      readCredential(`other=value; shipkeep_session=${token}`, 'shipkeep_session').expose(),
    ).toBe(token);
    for (const cookie of [
      undefined,
      'shipkeep_session=bad',
      `shipkeep_session=${token}; shipkeep_session=${token}`,
      `shipkeep_session=%41${token}`,
    ]) {
      expect(() => readCredential(cookie, 'shipkeep_session')).toThrow('Authentication failed.');
    }
  });
  it('only accepts the configured origin for mutations', () => {
    const request = (origin?: string, site?: string) =>
      ({ headers: { origin, 'sec-fetch-site': site } }) as Request;
    expect(() => {
      assertOrigin(request('https://shipkeep.example.com'), 'https://shipkeep.example.com');
    }).not.toThrow();
    for (const origin of [
      undefined,
      'null',
      'https://attacker.example.com',
      'https://shipkeep.example.com.attacker.com',
      'https://shipkeep.example.com/',
    ]) {
      expect(() => {
        assertOrigin(request(origin), 'https://shipkeep.example.com');
      }).toThrow();
    }
    expect(() => {
      assertOrigin(
        request('https://shipkeep.example.com', 'cross-site'),
        'https://shipkeep.example.com',
      );
    }).toThrow();
  });
  it('sets host-bound secure cookies on HTTPS and keeps only CSRF readable by JavaScript', () => {
    const cookie = vi.fn();
    const response = { cookie } as unknown as Response;
    const grant = {
      userId: 'test-user',
      email: 'person@example.com',
      token: new Secret(token),
      csrf: new Secret('B'.repeat(43)),
      expiresAt: new Date(Date.now() + 10000),
    };
    const policy = cookiePolicy('https://shipkeep.example.com');
    setSessionCookies(response, grant, policy);
    expect(cookie).toHaveBeenCalledWith(
      '__Host-shipkeep_session',
      token,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        expires: grant.expiresAt,
      }),
    );
    expect(cookie).toHaveBeenCalledWith(
      '__Host-shipkeep_csrf',
      grant.csrf.expose(),
      expect.objectContaining({ httpOnly: false, secure: true }),
    );
    expect(cookie.mock.calls.every((call) => !Object.hasOwn(call[2] as object, 'domain'))).toBe(
      true,
    );
    expect(cookiePolicy('http://localhost:3000')).toMatchObject({
      name: 'shipkeep_session',
      secure: false,
    });
  });
});

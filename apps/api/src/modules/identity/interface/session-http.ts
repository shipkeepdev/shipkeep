import { isIP } from 'node:net';

import { ForbiddenException } from '@nestjs/common';
import { Secret } from '@shipkeep/domain';
import type { Request, Response } from 'express';

import type { SessionGrant } from '../application/session-commands';
import type { ResourceSecurityContext } from '../application/resource-security-context';
import { AuthenticationError, TOKEN_PATTERN } from '../domain/identity-policy';

export interface CookiePolicy {
  readonly name: string;
  readonly csrfName: string;
  readonly secure: boolean;
}
export interface SessionPrincipal {
  readonly kind: 'session';
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  readonly securityVersion: number;
  readonly expiresAt: Date;
  readonly token: Secret;
}
export interface ApiTokenPrincipal {
  readonly kind: 'api_token';
  readonly userId: string;
  readonly email: string;
  readonly tokenId: string;
  readonly securityVersion: number;
  readonly expiresAt: Date;
  readonly token: Secret;
}
export type IdentityPrincipal = SessionPrincipal | ApiTokenPrincipal;
export type IdentityRequest = Request<Record<string, string>, unknown, unknown> & {
  identity?: IdentityPrincipal;
};

export function cookiePolicy(publicUrl: string): CookiePolicy {
  const secure = new URL(publicUrl).protocol === 'https:';
  const prefix = secure ? '__Host-' : '';
  return { name: `${prefix}shipkeep_session`, csrfName: `${prefix}shipkeep_csrf`, secure };
}

export function readCredential(header: string | undefined, name: string): Secret {
  const values = (header ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  if (values.length !== 1) throw new AuthenticationError();
  return headerCredential(values[0].slice(name.length + 1));
}

export function headerCredential(value: string | string[] | undefined): Secret {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) throw new AuthenticationError();
  return new Secret(value);
}

export function assertOrigin(request: Pick<Request, 'headers'>, publicUrl: string): void {
  if (
    request.headers.origin !== new URL(publicUrl).origin ||
    request.headers['sec-fetch-site'] === 'cross-site'
  ) {
    throw new ForbiddenException('Request origin is not allowed.');
  }
}

export function setSessionCookies(
  response: Response,
  grant: SessionGrant,
  policy: CookiePolicy,
): void {
  const options = {
    secure: policy.secure,
    sameSite: 'strict' as const,
    path: '/',
    expires: grant.expiresAt,
  };
  response.cookie(policy.name, grant.token.expose(), { ...options, httpOnly: true });
  response.cookie(policy.csrfName, grant.csrf.expose(), { ...options, httpOnly: false });
}

export function clearSessionCookies(response: Response, policy: CookiePolicy): void {
  const options = { secure: policy.secure, sameSite: 'strict' as const, path: '/' };
  response.clearCookie(policy.name, { ...options, httpOnly: true });
  response.clearCookie(policy.csrfName, { ...options, httpOnly: false });
}

export function clientIp(request: Request): string {
  const ip = request.ip;
  if (ip && isIP(ip)) return ip;
  return request.socket.remoteAddress ?? 'unknown';
}

export function principal(request: IdentityRequest): SessionPrincipal {
  if (request.identity?.kind !== 'session') throw new AuthenticationError();
  return request.identity;
}

export function authenticatedPrincipal(request: IdentityRequest): IdentityPrincipal {
  if (!request.identity) throw new AuthenticationError();
  return request.identity;
}

/** Preserve the authenticated credential for the command's transactional revalidation. */
export function resourceContext(request: IdentityRequest): ResourceSecurityContext {
  const actor = authenticatedPrincipal(request);
  return {
    userId: actor.userId,
    securityVersion: actor.securityVersion,
    ip: clientIp(request),
    userAgent: request.headers['user-agent'] ?? '',
    ...(actor.kind === 'api_token'
      ? { apiCredential: { id: actor.tokenId, value: actor.token } }
      : {}),
  };
}
